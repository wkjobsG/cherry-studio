import { DEFAULT_MAX_TOKENS } from '@renderer/config/constant'
import {
  getOpenAIWebSearchParams,
  isGrokReasoningModel,
  isHunyuanSearchModel,
  isOpenAIoSeries,
  isOpenAIWebSearch,
  isReasoningModel,
  isSupportedModel,
  isVisionModel,
  isZhipuModel
} from '@renderer/config/models'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { getAssistantSettings, getDefaultModel, getTopNamingModel } from '@renderer/services/AssistantService'
import { EVENT_NAMES } from '@renderer/services/EventService'
import {
  filterContextMessages,
  filterEmptyMessages,
  filterUserRoleStartMessages
} from '@renderer/services/MessagesService'
import store from '@renderer/store'
import {
  Assistant,
  FileTypes,
  GenerateImageParams,
  MCPToolResponse,
  Message,
  Model,
  Provider,
  Suggestion
} from '@renderer/types'
import { removeSpecialCharactersForTopicName } from '@renderer/utils'
import { addImageFileToContents } from '@renderer/utils/formats'
import { mcpToolCallResponseToOpenAIMessage, parseAndCallTools } from '@renderer/utils/mcp-tools'
import { buildSystemPrompt } from '@renderer/utils/prompt'
import { isEmpty, takeRight } from 'lodash'
import OpenAI, { AzureOpenAI } from 'openai'
import {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam
} from 'openai/resources'

import { CompletionsParams } from '.'
import BaseProvider from './BaseProvider'

type ReasoningEffort = 'high' | 'medium' | 'low'

export default class OpenAIProvider extends BaseProvider {
  private sdk: OpenAI

  constructor(provider: Provider) {
    super(provider)

    if (provider.id === 'azure-openai' || provider.type === 'azure-openai') {
      this.sdk = new AzureOpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: this.apiKey,
        apiVersion: provider.apiVersion,
        endpoint: provider.apiHost
      })
      return
    }

    this.sdk = new OpenAI({
      dangerouslyAllowBrowser: true,
      apiKey: this.apiKey,
      baseURL: this.getBaseURL(),
      defaultHeaders: {
        ...this.defaultHeaders(),
        ...(this.provider.id === 'copilot' ? { 'editor-version': 'vscode/1.97.2' } : {})
      }
    })
  }

  /**
   * Check if the provider does not support files
   * @returns True if the provider does not support files, false otherwise
   */
  private get isNotSupportFiles() {
    if (this.provider?.isNotSupportArrayContent) {
      return true
    }

    const providers = ['deepseek', 'baichuan', 'minimax', 'xirang']

    return providers.includes(this.provider.id)
  }

  /**
   * Extract the file content from the message
   * @param message - The message
   * @returns The file content
   */
  private async extractFileContent(message: Message) {
    if (message.files && message.files.length > 0) {
      const textFiles = message.files.filter((file) => [FileTypes.TEXT, FileTypes.DOCUMENT].includes(file.type))

      if (textFiles.length > 0) {
        let text = ''
        const divider = '\n\n---\n\n'

        for (const file of textFiles) {
          const fileContent = (await window.api.file.read(file.id + file.ext)).trim()
          const fileNameRow = 'file: ' + file.origin_name + '\n\n'
          text = text + fileNameRow + fileContent + divider
        }

        return text
      }
    }

    return ''
  }

  /**
   * Get the message parameter
   * @param message - The message
   * @param model - The model
   * @returns The message parameter
   */
  private async getMessageParam(
    message: Message,
    model: Model
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    const isVision = isVisionModel(model)
    const content = await this.getMessageContent(message)

    // If the message does not have files, return the message
    if (isEmpty(message.files)) {
      return {
        role: message.role,
        content
      }
    }

    // If the model does not support files, extract the file content
    if (this.isNotSupportFiles) {
      const fileContent = await this.extractFileContent(message)

      return {
        role: message.role,
        content: content + '\n\n---\n\n' + fileContent
      }
    }

    // If the model supports files, add the file content to the message
    const parts: ChatCompletionContentPart[] = []

    if (content) {
      parts.push({ type: 'text', text: content })
    }

    for (const file of message.files || []) {
      if (file.type === FileTypes.IMAGE && isVision) {
        const image = await window.api.file.base64Image(file.id + file.ext)
        parts.push({
          type: 'image_url',
          image_url: { url: image.data }
        })
      }
      if ([FileTypes.TEXT, FileTypes.DOCUMENT].includes(file.type)) {
        const fileContent = await (await window.api.file.read(file.id + file.ext)).trim()
        parts.push({
          type: 'text',
          text: file.origin_name + '\n' + fileContent
        })
      }
    }

    return {
      role: message.role,
      content: parts
    } as ChatCompletionMessageParam
  }

  /**
   * Get the temperature for the assistant
   * @param assistant - The assistant
   * @param model - The model
   * @returns The temperature
   */
  private getTemperature(assistant: Assistant, model: Model) {
    return isReasoningModel(model) || isOpenAIWebSearch(model) ? undefined : assistant?.settings?.temperature
  }

  /**
   * Get the provider specific parameters for the assistant
   * @param assistant - The assistant
   * @param model - The model
   * @returns The provider specific parameters
   */
  private getProviderSpecificParameters(assistant: Assistant, model: Model) {
    const { maxTokens } = getAssistantSettings(assistant)

    if (this.provider.id === 'openrouter') {
      if (model.id.includes('deepseek-r1')) {
        return {
          include_reasoning: true
        }
      }
    }

    if (this.isOpenAIReasoning(model)) {
      return {
        max_tokens: undefined,
        max_completion_tokens: maxTokens
      }
    }

    return {}
  }

  /**
   * Get the top P for the assistant
   * @param assistant - The assistant
   * @param model - The model
   * @returns The top P
   */
  private getTopP(assistant: Assistant, model: Model) {
    if (isReasoningModel(model) || isOpenAIWebSearch(model)) return undefined

    return assistant?.settings?.topP
  }

  /**
   * Get the reasoning effort for the assistant
   * @param assistant - The assistant
   * @param model - The model
   * @returns The reasoning effort
   */
  private getReasoningEffort(assistant: Assistant, model: Model) {
    if (this.provider.id === 'groq') {
      return {}
    }

    if (isReasoningModel(model)) {
      if (model.provider === 'openrouter') {
        return {
          reasoning: {
            effort: assistant?.settings?.reasoning_effort
          }
        }
      }

      if (isGrokReasoningModel(model)) {
        return {
          reasoning_effort: assistant?.settings?.reasoning_effort
        }
      }

      if (isOpenAIoSeries(model)) {
        return {
          reasoning_effort: assistant?.settings?.reasoning_effort
        }
      }

      if (model.id.includes('claude-3.7-sonnet') || model.id.includes('claude-3-7-sonnet')) {
        const effortRatios: Record<ReasoningEffort, number> = {
          high: 0.8,
          medium: 0.5,
          low: 0.2
        }

        const effort = assistant?.settings?.reasoning_effort as ReasoningEffort
        const effortRatio = effortRatios[effort]

        if (!effortRatio) {
          return {}
        }

        const maxTokens = assistant?.settings?.maxTokens || DEFAULT_MAX_TOKENS
        const budgetTokens = Math.trunc(Math.max(Math.min(maxTokens * effortRatio, 32000), 1024))

        return {
          thinking: {
            type: 'enabled',
            budget_tokens: budgetTokens
          }
        }
      }

      return {}
    }

    return {}
  }

  /**
   * Check if the model is an OpenAI reasoning model
   * @param model - The model
   * @returns True if the model is an OpenAI reasoning model, false otherwise
   */
  private isOpenAIReasoning(model: Model) {
    return model.id.startsWith('o1') || model.id.startsWith('o3') || model.id.startsWith('o4')
  }

  /**
   * Generate completions for the assistant
   * @param messages - The messages
   * @param assistant - The assistant
   * @param mcpTools - The MCP tools
   * @param onChunk - The onChunk callback
   * @param onFilterMessages - The onFilterMessages callback
   * @returns The completions
   */
  async completions({ messages, assistant, mcpTools, onChunk, onFilterMessages }: CompletionsParams): Promise<void> {
    const defaultModel = getDefaultModel()
    const model = assistant.model || defaultModel
    const { contextCount, maxTokens, streamOutput } = getAssistantSettings(assistant)
    messages = addImageFileToContents(messages)
    let systemMessage = { role: 'system', content: assistant.prompt || '' }
    if (isOpenAIoSeries(model)) {
      systemMessage = {
        role: 'developer',
        content: `Formatting re-enabled${systemMessage ? '\n' + systemMessage.content : ''}`
      }
    }
    if (mcpTools && mcpTools.length > 0) {
      systemMessage.content = buildSystemPrompt(systemMessage.content || '', mcpTools)
    }

    const userMessages: ChatCompletionMessageParam[] = []
    const _messages = filterUserRoleStartMessages(
      filterEmptyMessages(filterContextMessages(takeRight(messages, contextCount + 1)))
    )

    onFilterMessages(_messages)

    for (const message of _messages) {
      userMessages.push(await this.getMessageParam(message, model))
    }

    const isSupportStreamOutput = () => {
      return streamOutput
    }

    let hasReasoningContent = false
    let lastChunk = ''
    const isReasoningJustDone = (
      delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
        reasoning_content?: string
        reasoning?: string
        thinking?: string
      }
    ) => {
      if (!delta?.content) return false

      // 检查当前chunk和上一个chunk的组合是否形成###Response标记
      const combinedChunks = lastChunk + delta.content
      lastChunk = delta.content

      // 检测思考结束
      if (combinedChunks.includes('###Response') || delta.content === '</think>') {
        return true
      }

      // 如果有reasoning_content或reasoning，说明是在思考中
      if (delta?.reasoning_content || delta?.reasoning || delta?.thinking) {
        hasReasoningContent = true
      }

      // 如果之前有reasoning_content或reasoning，现在有普通content，说明思考结束
      if (hasReasoningContent && delta.content) {
        return true
      }

      return false
    }

    let time_first_token_millsec = 0
    let time_first_content_millsec = 0
    const start_time_millsec = new Date().getTime()
    const lastUserMessage = _messages.findLast((m) => m.role === 'user')

    const { abortController, cleanup, signalPromise } = this.createAbortController(lastUserMessage?.id, true)
    const { signal } = abortController
    await this.checkIsCopilot()

    //当 systemMessage 内容为空时不发送 systemMessage
    let reqMessages: ChatCompletionMessageParam[]
    if (!systemMessage.content) {
      reqMessages = [...userMessages]
    } else {
      reqMessages = [systemMessage, ...userMessages].filter(Boolean) as ChatCompletionMessageParam[]
    }

    const toolResponses: MCPToolResponse[] = []
    let firstChunk = true

    const processToolUses = async (content: string, idx: number) => {
      const toolResults = await parseAndCallTools(
        content,
        toolResponses,
        onChunk,
        idx,
        mcpToolCallResponseToOpenAIMessage,
        mcpTools,
        isVisionModel(model)
      )

      if (toolResults.length > 0) {
        reqMessages.push({
          role: 'assistant',
          content: content
        } as ChatCompletionMessageParam)
        toolResults.forEach((ts) => reqMessages.push(ts as ChatCompletionMessageParam))

        const newStream = await this.sdk.chat.completions
          // @ts-ignore key is not typed
          .create(
            {
              model: model.id,
              messages: reqMessages,
              temperature: this.getTemperature(assistant, model),
              top_p: this.getTopP(assistant, model),
              max_tokens: maxTokens,
              keep_alive: this.keepAliveTime,
              stream: isSupportStreamOutput(),
              // tools: tools,
              ...getOpenAIWebSearchParams(assistant, model),
              ...this.getReasoningEffort(assistant, model),
              ...this.getProviderSpecificParameters(assistant, model),
              ...this.getCustomParameters(assistant)
            },
            {
              signal
            }
          )
        await processStream(newStream, idx + 1)
      }
    }

    const processStream = async (stream: any, idx: number) => {
      if (!isSupportStreamOutput()) {
        const time_completion_millsec = new Date().getTime() - start_time_millsec
        return onChunk({
          text: stream.choices[0].message?.content || '',
          usage: stream.usage,
          metrics: {
            completion_tokens: stream.usage?.completion_tokens,
            time_completion_millsec,
            time_first_token_millsec: 0
          }
        })
      }

      let content = ''
      for await (const chunk of stream) {
        if (window.keyv.get(EVENT_NAMES.CHAT_COMPLETION_PAUSED)) {
          break
        }

        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          content += delta.content
        }

        if (delta?.reasoning_content || delta?.reasoning) {
          hasReasoningContent = true
        }

        if (time_first_token_millsec == 0) {
          time_first_token_millsec = new Date().getTime() - start_time_millsec
        }

        if (time_first_content_millsec == 0 && isReasoningJustDone(delta)) {
          time_first_content_millsec = new Date().getTime()
        }

        const time_completion_millsec = new Date().getTime() - start_time_millsec
        const time_thinking_millsec = time_first_content_millsec ? time_first_content_millsec - start_time_millsec : 0

        // Extract citations from the raw response if available
        const citations = (chunk as OpenAI.Chat.Completions.ChatCompletionChunk & { citations?: string[] })?.citations

        const finishReason = chunk.choices[0]?.finish_reason

        let webSearch: any[] | undefined = undefined
        if (assistant.enableWebSearch && isZhipuModel(model) && finishReason === 'stop') {
          webSearch = chunk?.web_search
        }
        if (firstChunk && assistant.enableWebSearch && isHunyuanSearchModel(model)) {
          webSearch = chunk?.search_info?.search_results
          firstChunk = true
        }
        onChunk({
          text: delta?.content || '',
          reasoning_content: delta?.reasoning_content || delta?.reasoning || '',
          usage: chunk.usage,
          metrics: {
            completion_tokens: chunk.usage?.completion_tokens,
            time_completion_millsec,
            time_first_token_millsec,
            time_thinking_millsec
          },
          webSearch,
          annotations: delta?.annotations,
          citations,
          mcpToolResponse: toolResponses
        })
      }

      await processToolUses(content, idx)
    }
    // console.log('reqMessages', reqMessages)
    const stream = await this.sdk.chat.completions
      // @ts-ignore key is not typed
      .create(
        {
          model: model.id,
          messages: reqMessages,
          temperature: this.getTemperature(assistant, model),
          top_p: this.getTopP(assistant, model),
          max_tokens: maxTokens,
          keep_alive: this.keepAliveTime,
          stream: isSupportStreamOutput(),
          // tools: tools,
          ...getOpenAIWebSearchParams(assistant, model),
          ...this.getReasoningEffort(assistant, model),
          ...this.getProviderSpecificParameters(assistant, model),
          ...this.getCustomParameters(assistant)
        },
        {
          signal
        }
      )

    await processStream(stream, 0).finally(cleanup)
    // 捕获signal的错误
    await signalPromise?.promise?.catch((error) => {
      throw error
    })
  }

  /**
   * Translate a message
   * @param message - The message
   * @param assistant - The assistant
   * @param onResponse - The onResponse callback
   * @returns The translated message
   */
  async translate(message: Message, assistant: Assistant, onResponse?: (text: string) => void) {
    const defaultModel = getDefaultModel()
    const model = assistant.model || defaultModel
    const messages = message.content
      ? [
          { role: 'system', content: assistant.prompt },
          { role: 'user', content: message.content }
        ]
      : [{ role: 'user', content: assistant.prompt }]

    const isOpenAIReasoning = this.isOpenAIReasoning(model)

    const isSupportedStreamOutput = () => {
      if (!onResponse) {
        return false
      }
      if (isOpenAIReasoning) {
        return false
      }
      return true
    }

    const stream = isSupportedStreamOutput()

    await this.checkIsCopilot()

    // @ts-ignore key is not typed
    const response = await this.sdk.chat.completions.create({
      model: model.id,
      messages: messages as ChatCompletionMessageParam[],
      stream,
      keep_alive: this.keepAliveTime,
      temperature: assistant?.settings?.temperature
    })

    if (!stream) {
      return response.choices[0].message?.content || ''
    }

    let text = ''
    let isThinking = false
    const isReasoning = isReasoningModel(model)

    for await (const chunk of response) {
      const deltaContent = chunk.choices[0]?.delta?.content || ''

      if (isReasoning) {
        if (deltaContent.includes('<think>')) {
          isThinking = true
        }

        if (!isThinking) {
          text += deltaContent
          onResponse?.(text)
        }

        if (deltaContent.includes('</think>')) {
          isThinking = false
        }
      } else {
        text += deltaContent
        onResponse?.(text)
      }
    }

    return text
  }

  /**
   * Summarize a message
   * @param messages - The messages
   * @param assistant - The assistant
   * @returns The summary
   */
  public async summaries(messages: Message[], assistant: Assistant): Promise<string> {
    const model = getTopNamingModel() || assistant.model || getDefaultModel()

    const userMessages = takeRight(messages, 5)
      .filter((message) => !message.isPreset)
      .map((message) => ({
        role: message.role,
        content: message.content
      }))

    const userMessageContent = userMessages.reduce((prev, curr) => {
      const content = curr.role === 'user' ? `User: ${curr.content}` : `Assistant: ${curr.content}`
      return prev + (prev ? '\n' : '') + content
    }, '')

    const systemMessage = {
      role: 'system',
      content: getStoreSetting('topicNamingPrompt') || i18n.t('prompts.title')
    }

    const userMessage = {
      role: 'user',
      content: userMessageContent
    }

    await this.checkIsCopilot()

    // @ts-ignore key is not typed
    const response = await this.sdk.chat.completions.create({
      model: model.id,
      messages: [systemMessage, userMessage] as ChatCompletionMessageParam[],
      stream: false,
      keep_alive: this.keepAliveTime,
      max_tokens: 1000
    })

    // 针对思考类模型的返回，总结仅截取</think>之后的内容
    let content = response.choices[0].message?.content || ''
    content = content.replace(/^<think>(.*?)<\/think>/s, '')

    return removeSpecialCharactersForTopicName(content.substring(0, 50))
  }

  /**
   * Summarize a message for search
   * @param messages - The messages
   * @param assistant - The assistant
   * @returns The summary
   */
  public async summaryForSearch(messages: Message[], assistant: Assistant): Promise<string | null> {
    const model = assistant.model || getDefaultModel()

    const systemMessage = {
      role: 'system',
      content: assistant.prompt
    }

    const userMessage = {
      role: 'user',
      content: messages.map((m) => m.content).join('\n')
    }
    // @ts-ignore key is not typed
    const response = await this.sdk.chat.completions.create(
      {
        model: model.id,
        messages: [systemMessage, userMessage] as ChatCompletionMessageParam[],
        stream: false,
        keep_alive: this.keepAliveTime,
        max_tokens: 1000
      },
      {
        timeout: 20 * 1000
      }
    )

    // 针对思考类模型的返回，总结仅截取</think>之后的内容
    let content = response.choices[0].message?.content || ''
    content = content.replace(/^<think>(.*?)<\/think>/s, '')

    return content
  }

  /**
   * Generate text
   * @param prompt - The prompt
   * @param content - The content
   * @returns The generated text
   */
  public async generateText({ prompt, content }: { prompt: string; content: string }): Promise<string> {
    const model = getDefaultModel()

    await this.checkIsCopilot()

    const response = await this.sdk.chat.completions.create({
      model: model.id,
      stream: false,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content }
      ]
    })

    return response.choices[0].message?.content || ''
  }

  /**
   * Generate suggestions
   * @param messages - The messages
   * @param assistant - The assistant
   * @returns The suggestions
   */
  async suggestions(messages: Message[], assistant: Assistant): Promise<Suggestion[]> {
    const model = assistant.model

    if (!model) {
      return []
    }

    await this.checkIsCopilot()

    const response: any = await this.sdk.request({
      method: 'post',
      path: '/advice_questions',
      body: {
        messages: messages.filter((m) => m.role === 'user').map((m) => ({ role: m.role, content: m.content })),
        model: model.id,
        max_tokens: 0,
        temperature: 0,
        n: 0
      }
    })

    return response?.questions?.filter(Boolean)?.map((q: any) => ({ content: q })) || []
  }

  /**
   * Check if the model is valid
   * @param model - The model
   * @returns The validity of the model
   */
  public async check(model: Model): Promise<{ valid: boolean; error: Error | null }> {
    if (!model) {
      return { valid: false, error: new Error('No model found') }
    }
    const body = {
      model: model.id,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    }

    try {
      await this.checkIsCopilot()
      const response = await this.sdk.chat.completions.create(body as ChatCompletionCreateParamsNonStreaming)

      return {
        valid: Boolean(response?.choices[0].message),
        error: null
      }
    } catch (error: any) {
      return {
        valid: false,
        error
      }
    }
  }

  /**
   * Get the models
   * @returns The models
   */
  public async models(): Promise<OpenAI.Models.Model[]> {
    try {
      await this.checkIsCopilot()

      const response = await this.sdk.models.list()

      if (this.provider.id === 'github') {
        // @ts-ignore key is not typed
        return response.body
          .map((model) => ({
            id: model.name,
            description: model.summary,
            object: 'model',
            owned_by: model.publisher
          }))
          .filter(isSupportedModel)
      }

      if (this.provider.id === 'together') {
        // @ts-ignore key is not typed
        return response?.body
          .map((model: any) => ({
            id: model.id,
            description: model.display_name,
            object: 'model',
            owned_by: model.organization
          }))
          .filter(isSupportedModel)
      }

      const models = response?.data || []

      return models.filter(isSupportedModel)
    } catch (error) {
      return []
    }
  }

  /**
   * Generate an image
   * @param params - The parameters
   * @returns The generated image
   */
  public async generateImage({
    model,
    prompt,
    negativePrompt,
    imageSize,
    batchSize,
    seed,
    numInferenceSteps,
    guidanceScale,
    signal,
    promptEnhancement
  }: GenerateImageParams): Promise<string[]> {
    const response = (await this.sdk.request({
      method: 'post',
      path: '/images/generations',
      signal,
      body: {
        model,
        prompt,
        negative_prompt: negativePrompt,
        image_size: imageSize,
        batch_size: batchSize,
        seed: seed ? parseInt(seed) : undefined,
        num_inference_steps: numInferenceSteps,
        guidance_scale: guidanceScale,
        prompt_enhancement: promptEnhancement
      }
    })) as { data: Array<{ url: string }> }

    return response.data.map((item) => item.url)
  }

  /**
   * Get the embedding dimensions
   * @param model - The model
   * @returns The embedding dimensions
   */
  public async getEmbeddingDimensions(model: Model): Promise<number> {
    await this.checkIsCopilot()

    const data = await this.sdk.embeddings.create({
      model: model.id,
      input: model?.provider === 'baidu-cloud' ? ['hi'] : 'hi'
    })
    return data.data[0].embedding.length
  }

  public async checkIsCopilot() {
    if (this.provider.id !== 'copilot') return
    const defaultHeaders = store.getState().copilot.defaultHeaders
    // copilot每次请求前需要重新获取token，因为token中附带时间戳
    const { token } = await window.api.copilot.getToken(defaultHeaders)
    this.sdk.apiKey = token
  }
}
