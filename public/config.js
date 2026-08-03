// AllinONE 运行时后端配置（部署后可修改此文件，无需重新构建）
//
// apiBaseUrl：后端服务基地址，必须以 /api 结尾。
//   留空 ''  → 使用同源相对路径（适用于 server.js 同源托管前端 + 后端的部署，
//             即直接通过 CloudStudio / CloudRun 的预览 URL 访问应用）。
//   设置值   → Service Worker 会读取此值，将本站所有同域 /api/* 请求代理到该后端，
//             从而修复「CloudBase 静态托管下 /api 被 rewrite 到 index.html 导致后端不可达」的问题。
//
// 例（CloudStudio 后端）：
//   window.__API_BASE_URL = 'http://c647c55bf7ac4a28be18134cc8890844.codebuddy.cloudstudio.run:5000/api';
//
// 注意：CloudStudio 预览 URL 在每次重新部署后可能变化，请同步更新此处。
window.__API_BASE_URL = 'https://allinonegaming-d4gmsmrzz573264f6.service.tcloudbase.com/api';
