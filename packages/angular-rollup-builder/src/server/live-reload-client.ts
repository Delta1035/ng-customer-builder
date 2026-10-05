/**
 * 注入到开发页面中的浏览器客户端（只在 dev-server 返回的 HTML 中出现，不进入构建产物）。
 *
 * 通过 SSE（EventSource）接收服务器推送的构建状态：
 *   building → 无操作
 *   success  → 如果服务器的构建代次与页面加载时不同，整页刷新
 *   error    → 显示错误浮层（用 textContent 渲染，错误文本不会被当作 HTML 执行）
 * EventSource 断线会自动重连；重连后服务器立即推送当前状态，所以错过的事件不会造成不一致。
 *
 * 这是普通 <script>（非 module），以便通过 document.currentScript 读取 data-* 参数。
 */
export const LIVE_RELOAD_CLIENT = String.raw`(function () {
  var script = document.currentScript;
  var loadedBuild = script.getAttribute('data-build-id');
  var source = new EventSource(script.getAttribute('data-events-url'));
  var overlay = null;

  function showError(errors) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ng-rollup-error-overlay';
      overlay.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:24px;' +
        'background:rgba(20,20,20,.92);color:#ffb4b4;font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap');
      document.body.appendChild(overlay);
    }
    overlay.textContent = '构建失败（修复后页面将自动刷新）\n\n' + errors.join('\n\n');
  }

  source.addEventListener('state', function (event) {
    var state = JSON.parse(event.data);
    if (state.status === 'error') {
      showError(state.errors);
    } else if (state.status === 'success' && state.buildId !== loadedBuild) {
      location.reload();
    } else if (state.status === 'success' && overlay) {
      overlay.remove();
      overlay = null;
    }
  });
})();
`;
