#!/usr/bin/env osascript -l JavaScript

// 通过 Chrome AppleScript 接口在 TikTok Symphony 页面上点击 "Looks good" 按钮

const chrome = Application('Google Chrome');
const win = chrome.windows[0];
const tab = win.tabs[0]; // 第一个 tab 就是 creativestudio/chat

const jsCode = `
(function() {
  var allEls = document.querySelectorAll('button, [role="button"], div, span');
  var results = [];
  for (var i = 0; i < allEls.length; i++) {
    var el = allEls[i];
    var text = (el.textContent || "").trim();
    if (text.toLowerCase().indexOf("looks good") >= 0 && text.length < 80) {
      var rect = el.getBoundingClientRect();
      if (rect.width > 80 && rect.height > 15 && rect.width < 800) {
        var style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden") {
          el.scrollIntoView({block: "center"});
          el.click();
          return "CLICKED: " + el.tagName + " | " + text.substring(0,60) + " | " + Math.round(rect.width) + "x" + Math.round(rect.height);
        }
      }
    }
  }
  return "NOT_FOUND";
})()
`;
const result = tab.execute({javascript: jsCode});
result;
