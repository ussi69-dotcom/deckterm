if (location.search.includes("debug=1")) {
  const script = document.createElement("script");
  script.src = "/dev/diagnostics.js";
  document.head.appendChild(script);
}
