import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Shown in the fallback so the user knows which tab crashed. */
  tabLabel?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Isolates a rendering failure to a single dashboard tab. Without this, an
 * uncaught error in one generated component unmounts the whole app (React's
 * default behavior on a render-phase error with no boundary), leaving a
 * blank screen with no indication of what went wrong.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Dashboard tab "${this.props.tabLabel ?? 'unknown'}" failed to render:`, error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card kpi-card" role="alert">
          <p className="kpi-label">
            {this.props.tabLabel ? `"${this.props.tabLabel}" failed to load` : 'This tab failed to load'}
          </p>
          <p style={{ color: 'var(--danger)', marginTop: '0.5rem', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.85rem' }}>
            {this.state.error.message}
          </p>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            Other tabs are unaffected. This usually means the generated code has a bug — try regenerating this
            dashboard (e.g. with /update) to fix it.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
