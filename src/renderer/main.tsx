import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class RenderBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="fatal-error"><h1>GitDesk couldn’t display this view</h1>
      <p>Your repository files have not been changed by this display error.</p><pre>{this.state.error}</pre>
      <button className="button primary" onClick={() => window.location.reload()}>Reload GitDesk</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><RenderBoundary><App /></RenderBoundary></React.StrictMode>);
