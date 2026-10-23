/** 加载 / 错误 / 空状态。样式沿用复刻站的 .state 系列。 */

export function PageLoading({ label = '加载中' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="spinner" />
      <p>{label}…</p>
    </div>
  );
}

export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <h2>加载失败</h2>
      <p>{message}</p>
      {onRetry && (
        <button className="button primary" type="button" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function PageEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {hint && <p>{hint}</p>}
    </div>
  );
}
