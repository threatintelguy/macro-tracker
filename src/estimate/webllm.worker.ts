/**
 * The on-device model runs here, off the main thread, so a meal estimate
 * never stalls the page.
 */

import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg)
}
