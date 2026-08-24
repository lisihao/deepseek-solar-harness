/** Shared browser WebSocket lifecycle for downlink-only async streams. */

type SocketItem<T> = { kind: 'frame'; value: T } | { kind: 'end' }

/**
 * Decode and consume one downlink-only WebSocket as an abortable async stream.
 * @param socket - Connected browser WebSocket whose messages form the downlink.
 * @param signal - Abort signal that closes the socket and ends iteration.
 * @param decode - Convert one browser message into the caller's frame type.
 * @param onMalformed - Report a frame that could not be decoded without ending the stream.
 * @param onOpen - Optional notification after the transport opens.
 * @returns Decoded frames until the transport closes or the caller aborts.
 */
export async function * readWebSocketDownlink<T>(
  socket: WebSocket,
  signal: AbortSignal,
  decode: (event: MessageEvent) => T,
  onMalformed: (error: unknown) => void,
  onOpen?: () => void,
): AsyncGenerator<T> {
  const inbox: SocketItem<T>[] = []
  let wake: (() => void) | undefined
  const enqueue = (item: SocketItem<T>): void => {
    inbox.push(item)
    wake?.()
    wake = undefined
  }
  const handleOpen = (): void => { onOpen?.() }
  const handleMessage = (event: MessageEvent): void => {
    try {
      enqueue({ kind: 'frame', value: decode(event) })
    } catch (error) {
      onMalformed(error)
    }
  }
  const handleClose = (): void => { enqueue({ kind: 'end' }) }
  const handleAbort = (): void => {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
  }
  socket.addEventListener('open', handleOpen)
  socket.addEventListener('message', handleMessage)
  socket.addEventListener('close', handleClose, { once: true })
  signal.addEventListener('abort', handleAbort, { once: true })
  if (signal.aborted) handleAbort()
  try {
    while (true) {
      while (inbox.length > 0) {
        const item = inbox.shift() as SocketItem<T>
        if (item.kind === 'end') return
        yield item.value
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  } finally {
    signal.removeEventListener('abort', handleAbort)
    socket.removeEventListener('open', handleOpen)
    socket.removeEventListener('message', handleMessage)
    socket.removeEventListener('close', handleClose)
    handleAbort()
  }
}
