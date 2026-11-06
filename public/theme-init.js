// Apply the saved theme (dark by default) before the app boots, so there is no light flash.
// The app re-applies the real setting from storage once it has loaded (see applyTheme).
(function () {
  var t = "dark";
  try {
    t = localStorage.getItem("nf-theme") || "dark";
  } catch (e) {}
  if (t === "system") t = window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t === "light" ? "light" : "dark";
})();
