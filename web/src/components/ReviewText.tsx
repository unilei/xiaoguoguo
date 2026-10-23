/**
 * 评论正文按换行拆成多段渲染。
 *
 * 原站是 `content.replace(/\n/g, '<br>')` 再塞进 innerHTML，
 * 直接当文本节点渲染会把多段合并成一整段，4 行 clamp 内呈现的字句就不一样了。
 * 这里拆成数组 + <br>，不引入 dangerouslySetInnerHTML。
 */
export function ReviewText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <p className="detail-review-text">
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 && <br />}
          {line}
        </span>
      ))}
    </p>
  );
}
