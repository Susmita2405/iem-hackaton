# SoumyaOps 🚀

> **Unified AI-powered DevOps & Team Knowledge Platform**
> RAG-first • Source-attributed answers • Auto-deploy • Smart debugging

---

## What it does

SoumyaOps is a production-ready SaaS platform that gives your engineering team an AI brain:

| Feature | How |
|---|---|
| **Team Knowledge RAG** | Captures Telegram chats + docs → vector DB → answers with citations |
| **Voice notes** | Telegram voice → Whisper transcription → embedded automatically |
| **Codebase understanding** | Clones GitHub repos, indexes every file, answers code questions |
| **Error detection + fix** | Paste logs → detects errors → RAG-powered fix suggestion |
| **Auto PR creation** | Creates GitHub PRs for fixes — never merges automatically |
| **Auto deployment** | Detects frontend/backend → Vercel / Railway deploy with ENV injection |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js (ESM) |
| Frontend | React 18 + Vite + Tailwind CSS |
| Database | PostgreSQL 16 (raw SQL, no ORM) |
| Vector DB | Pinecone |
| AI / RAG | LangChain JS + Anthropic Claude (claude-sonnet-4) |
| Embeddings | OpenAI text-embedding-3-large |
| Voice | OpenAI Whisper |
| Queue | BullMQ + Redis |
| Auth | JWT + GitHub OAuth |
| Bot | Telegram Bot API (webhook mode) |
| Deploy | Vercel API + Railway GraphQL API |

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- Accounts: Anthropic, OpenAI, Pinecone, GitHub OAuth App, Vercel, Railway

### 1. Clone & configure

```bash
git clone https://github.com/yourname/soumyaops.git
cd soumyaops
cp .env.example .env
# Edit .env with your API keys
```

### 2. Create GitHub OAuth App

1. Go to GitHub → Settings → Developer settings → OAuth Apps → New
2. Homepage URL: `http://localhost:5173`
3. Callback URL: `http://localhost:4000/api/auth/github/callback`
4. Copy Client ID and Secret to `.env`

### 3. Create Pinecone Index

1. Go to [pinecone.io](https://pinecone.io) → Create Index
2. Name: `soumyaops`
3. Dimensions: `3072` (text-embedding-3-large)
4. Metric: `cosine`
5. Copy API key to `.env`

### 4. Start with Docker

```bash
docker-compose up -d
```

This starts PostgreSQL, Redis, the backend API, and the React frontend.

### 5. Run migrations manually (first time)

```bash
docker exec -it soumyaops-postgres psql -U postgres -d soumyaops \
  -f /docker-entrypoint-initdb.d/001_initial_schema.sql
```

### 6. Or start without Docker

```bash
# Start PostgreSQL and Redis locally, then:

cd backend
npm install
npm run dev

cd ../frontend
npm install
npm run dev
```

Open `http://localhost:5173`

---

## Project Structure

```
soumyaops/
├── backend/
│   └── src/
│       ├── services/
│       │   ├── rag/           # Full RAG pipeline
│       │   ├── ingestion/     # Telegram + file + log ingestion
│       │   ├── github/        # Octokit + repo analysis + PR creation
│       │   ├── deploy/        # Vercel + Railway deployment
│       │   └── debug/         # Error detection + fix generation
│       ├── jobs/              # BullMQ workers
│       ├── routes/            # Express routes
│       ├── controllers/       # Request handlers
│       └── middleware/        # Auth, secret detection, error handling
└── frontend/
    └── src/
        ├── pages/             # All 8 UI pages
        ├── components/        # Reusable components
        ├── store/             # Zustand state
        └── lib/               # Axios API client
```

---

## RAG Pipeline

Every query goes through this pipeline — no raw LLM responses:

```
Question
  → Hybrid Retrieval (Pinecone vector + PostgreSQL full-text)
  → MMR Re-ranking (diversity + relevance balance)
  → Context Builder (structured prompt with sources)
  → Claude generates answer
  → Answer includes [Source N] citations
```

**Chunking strategies by content type:**

| Source | Strategy | Chunk size |
|---|---|---|
| Telegram messages | Atomic (preserve whole messages) | ~800 chars |
| Code files | Function/class boundary splitting | ~1200 chars |
| Log files | Error block splitting (stack traces together) | ~1200 chars |
| Documents | Semantic paragraph splitting | ~1000 chars |

---

## Telegram Setup

1. Create a bot via @BotFather → `/newbot`
2. Copy the token
3. In SoumyaOps UI → Telegram page → paste token → Connect
4. Add the bot to your Telegram group
5. Messages and voice notes are automatically ingested

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/github` | GET | Start GitHub OAuth |
| `/api/workspaces` | POST/GET | Create/list workspaces |
| `/api/rag/query` | POST | RAG question answering |
| `/api/rag/query/stream` | GET | SSE streaming RAG |
| `/api/ingest/file` | POST | Upload .txt/.json file |
| `/api/ingest/logs` | POST | Submit raw logs |
| `/api/github/repos` | POST/GET | Add/list repositories |
| `/api/github/prs` | GET | List SoumyaOps PRs |
| `/api/deploy` | POST/GET | Trigger/list deployments |
| `/api/debug/errors` | GET | List detected errors |
| `/api/debug/fix` | POST | Generate AI fix |
| `/api/debug/pr` | POST | Create fix PR |
| `/api/telegram/webhook/:slug` | POST | Telegram webhook |

---

## Security Notes

- Secrets are masked in logs via regex patterns (API keys, tokens, passwords)
- GitHub tokens stored per-user (not in code)
- ENV variables for deployments are passed securely and never logged
- JWT auth on all routes (except webhook and OAuth callback)
- Rate limiting: 200 requests per 15 minutes
- PRs are always created as **drafts** — SoumyaOps never auto-merges

---

## Queue Jobs

| Queue | Triggers | Worker concurrency |
|---|---|---|
| `embed` | Message ingestion, voice transcription, file upload | 5 |
| `repo-analyze` | New GitHub repo added | 2 |
| `deploy` | User clicks Deploy | 3 |
| `log-process` | Log paste submitted | 5 |
| `fix-generate` | User requests AI fix | 3 |

Real-time progress is pushed to the frontend via WebSocket.

---

## License

MIT
Susmita