# 貢獻指南

繁體中文 · [English](CONTRIBUTING.md)

ContextOS 是實驗性專案。比起大範圍增加功能，我們更偏好有測試、證據清楚的聚焦變更。

## 開發

```powershell
git clone https://github.com/HayronHgh/context-os.git
cd context-os
node --test
```

目前 Runtime 不需要安裝 dependency。

## Pull requests

1. 每個 PR 聚焦一個問題。
2. 解釋 user impact 與 design trade-off。
3. 新增或更新測試。
4. 行為變更時同步更新英文與繁中文件。
5. 不得提交 local configs、`.qwen-agent`、logs、model files 或 secrets。
6. Tool、command、path 或 memory 變更必須說明安全影響。

## 專案優先順序

- 可量測的 context recovery quality
- 正確性與可恢復性
- 可稽核性
- 小 dependency surface
- 明確安全邊界

Embedding、多 Agent orchestration 或 UI 等大型功能應附具體 use case，並避免模糊核心 context-lifecycle hypothesis。
