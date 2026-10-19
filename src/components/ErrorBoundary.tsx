/**
 * ErrorBoundary - 全局渲染错误边界
 *
 * 背景：/platform-data-center 曾因后端返回异常数据形状（对象冒充数组）在渲染期
 * 抛出 TypeError，React 18 未捕获的渲染错误会卸载整棵树 → 全站白屏且无任何提示。
 *
 * 在 App.tsx 中包住 <Routes>，任何路由组件的渲染崩溃都会落到这里，
 * 展示可恢复的错误页（刷新/返回基地），而不是无声白屏。
 */
import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 渲染崩溃已拦截:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 flex items-center justify-center text-white">
          <div className="text-center max-w-md px-6">
            <p className="text-4xl mb-4">⚠️</p>
            <h1 className="text-lg font-bold mb-2">页面出了点问题</h1>
            <p className="text-sm text-slate-400 mb-1">
              渲染时发生错误，已阻止整站白屏：
            </p>
            <p className="text-xs text-red-300/80 font-mono bg-slate-800/80 rounded-lg p-3 mb-6 break-all">
              {this.state.error.message}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-medium transition-colors"
              >
                刷新页面
              </button>
              <button
                onClick={() => {
                  this.setState({ error: null });
                  window.location.hash = '';
                  window.location.href = '/';
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition-colors"
              >
                返回基地
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
