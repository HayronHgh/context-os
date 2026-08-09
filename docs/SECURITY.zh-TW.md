# 安全說明

繁體中文 · [English](SECURITY.md)

## 安全狀態

ContextOS 是實驗性 Research MVP。它替模型要求的工具提供 guardrails，但**不是安全邊界**，也沒有強 operating-system sandbox。

## Trust boundaries

### 本機模型

Model output 屬於不可信輸入。Runtime 會解析並路由 tool name 與 JSON arguments。模型不會直接取得 llama-server 內建 filesystem API。

### File tools

File path 會先通過 lexical project-root containment，再把每個已存在的 path component 交由 filesystem 解析，並與 real project root 比對。讀取、寫入與編輯都會拒絕透過 symbolic-link file、symbolic-link directory 或 Windows junction 逃逸；新目標則檢查其最近的既存 parent。

這是 defense in depth，不是沒有 race condition 的 OS sandbox。若惡意 process 能在檢查同時替換 path component，仍可能存在 time-of-check/time-of-use 風險。

這個 containment 只適用 ContextOS file tools，不會限制已核准 shell command 內的任意路徑。

### Shell commands

`run_command` 透過 host shell，以目前使用者權限執行。Runtime 會：

- 預設要求人工確認
- 設定 timeout
- 限制捕捉的 output
- 拒絕少量常見破壞性命令 deny list

這些控制並不完整，同一種破壞行為可以有許多表達方式。Repository、prompt、model 或生成命令不可信時，請使用 VM 或 container。

### 持久記憶

`.qwen-agent/` 是 plaintext，可能包含：

- 專有 source 或 snippets
- 內部路徑與架構
- Command/test output
- 工具印出的 environment values
- Prompt 或 log 中意外出現的 secrets

未經檢查不要 commit 或同步。

### 本機 HTTP server

Example server 綁定 `127.0.0.1` 並將 CORS 限為 localhost，但沒有設定 API key 或 TLS。若沒有 authentication、TLS、firewall 與明確 threat model，不要改為 `0.0.0.0` 或開放 LAN。

## Approval modes

預設會在 `write_file`、`edit_file`、`run_command` 前詢問。

`--yes` 會在該 session 自動核准，並不代表操作變安全；不可用於不可信 repository。

## 建議部署方式

重要工作建議：

1. 使用專用 OS account 或拋棄式 VM。
2. Model server 只留在 localhost。
3. 從乾淨 Git branch 工作，經常建立可 review commit。
4. 不要讓 Agent process 取得 production credentials。
5. 人工檢查每個 shell command 與 diff。
6. Repository 備份不可依賴 Agent memory。
7. 使用後刪除敏感 artifacts 與 sessions。

## 回報漏洞

請勿在 public issue 公開 exploit 細節。若 GitHub repository 支援，請使用 private vulnerability reporting，或透過 maintainer profile 聯絡。

請附上受影響版本、作業系統、設定、重現步驟、影響與可能修正方式。
