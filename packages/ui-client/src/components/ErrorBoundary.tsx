/**
 * Error boundary. A render failure anywhere below it shows a recoverable panel
 * instead of a blank page; the message is real (never a fabricated success).
 */
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  title: string
  body: string
  reloadLabel: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the detail in the console for the Host log; the UI stays calm.
    console.error('HyMemory Studio render error', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="state state--error" role="alert" style={{ margin: 24 }}>
        <p className="state__title">{this.props.title}</p>
        <p className="state__body">{this.props.body}</p>
        <p className="state__body mono wrap-anywhere">{error.message}</p>
        <div className="state__actions">
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            {this.props.reloadLabel}
          </button>
        </div>
      </div>
    )
  }
}