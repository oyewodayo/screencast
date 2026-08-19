// components/ErrorBoundary.tsx
//
// React only supports catching render-time errors via a class component's
// getDerivedStateFromError/componentDidCatch - there's no hooks equivalent. Wraps a subtree so an
// unguarded exception inside it (e.g. calling a Tiptap command against a not-yet-ready editor, or
// dispatching a stale ProseMirror position) shows a recoverable fallback instead of unmounting the
// entire app - which is what actually happened repeatedly while building Docs, since nothing in
// this app had an error boundary anywhere before this.
import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  // Called when the user clicks the fallback's reset button - must actually change what this
  // boundary renders (e.g. navigate away from the doc that crashed), not just clear local error
  // state, or the same subtree re-renders with the same props and crashes again immediately.
  onReset?: () => void;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("Caught render error:", error, info.componentStack);
  }

  handleReset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-neutral-50 dark:bg-neutral-950 text-center px-8">
          <p className="text-neutral-700 dark:text-neutral-200 font-medium">{this.props.fallbackTitle ?? "Something went wrong"}</p>
          <p className="text-xs text-neutral-400 dark:text-neutral-500 max-w-sm">{this.state.error.message}</p>
          <button
            type="button"
            onClick={this.handleReset}
            className="mt-1 px-4 py-2 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Go back
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
