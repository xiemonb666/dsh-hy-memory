export interface QueueJobLike {
  readonly id: string
  readonly payload_json: string
  readonly idempotency_key: string
  readonly lease_owner?: string | null
  readonly attempt: number
}

export interface QueueLease {
  readonly owner: string
  readonly attempt: number
}

export interface QueueStoreLike {
  getSettings(): { readonly settings: { readonly enabled: boolean; readonly capture: { readonly enabled: boolean } } }
  leaseJobs(owner: string, limit: number, leaseMs: number): QueueJobLike[]
  completeJob(id: string, result: unknown, lease: QueueLease): boolean
  failJob(id: string, errorCode: string, retryable: boolean, lease: QueueLease): boolean
}

export interface QueueDrainOptions {
  readonly store: QueueStoreLike
  readonly process: (envelope: unknown, idempotencyKey: string) => Promise<unknown>
  readonly concurrency: number
  readonly configuredCaptureEnabled?: boolean
  readonly logger: { warn(message: string): void }
}

export interface QueueDrain {
  drain(): Promise<void>
  dispose(timeoutMs?: number): Promise<void>
  isDisposed(): boolean
}

function retryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timeout|ECONNREFUSED|HTTP 5\d\d|unavailable/i.test(message)
}

/** A single-flight queue worker whose late async continuations never touch a closed store. */
export function createQueueDrain(options: QueueDrainOptions): QueueDrain {
  let disposed = false
  let draining = false
  let inFlight: Promise<void> | null = null

  const drain = async (): Promise<void> => {
    if (disposed || draining) return
    draining = true
    const run = (async () => {
      try {
        if (disposed) return
        if (options.configuredCaptureEnabled === false) return
        const { settings } = options.store.getSettings()
        if (!settings.enabled || !settings.capture.enabled) return
        const jobs = options.store.leaseJobs('host', options.concurrency, 60_000)
        for (const job of jobs) {
          if (disposed) return
          if (!job.lease_owner) {
            options.logger.warn(`hymem: queue job ${job.id} has no lease owner; leaving it unchanged`)
            continue
          }
          const lease = { owner: job.lease_owner, attempt: job.attempt }
          try {
            const envelope: unknown = JSON.parse(job.payload_json)
            const result = await options.process(envelope, job.idempotency_key)
            if (disposed) return
            if (!options.store.completeJob(job.id, result, lease)) {
              options.logger.warn(`hymem: queue job ${job.id} lease was superseded before completion`)
            }
          } catch (error) {
            if (disposed) return
            try {
              const { settings } = options.store.getSettings()
              if (!settings.enabled || !settings.capture.enabled) return
            } catch (settingsError) {
              options.logger.warn(
                `hymem: queue job ${job.id} failure left leased because settings are unavailable: ${settingsError instanceof Error ? settingsError.message : String(settingsError)}`,
              )
              return
            }
            const code = retryableError(error) ? 'E_BACKEND_UNAVAILABLE' : 'E_VALIDATION'
            if (!options.store.failJob(job.id, code, code === 'E_BACKEND_UNAVAILABLE', lease)) {
              options.logger.warn(`hymem: queue job ${job.id} lease was superseded before failure recording`)
            }
          }
        }
      } catch (error) {
        if (!disposed) options.logger.warn(`hymem: queue drain skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    inFlight = run
    try {
      await run
    } finally {
      draining = false
      if (inFlight === run) inFlight = null
    }
  }

  const dispose = async (timeoutMs = 5_000): Promise<void> => {
    disposed = true
    const pending = inFlight
    if (!pending) return
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        options.logger.warn(`hymem: queue drain did not stop within ${timeoutMs}ms; late completion will be ignored`)
        finish()
      }, Math.max(0, timeoutMs))
      pending.then(finish, finish)
    })
  }

  return { drain, dispose, isDisposed: () => disposed }
}
