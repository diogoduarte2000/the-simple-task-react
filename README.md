# the-simple-task-react

Frontend React/Vite para lista de tarefas com backend Node.js separado.

## Deploy no GitHub Pages

O GitHub Pages publica apenas o frontend estatico. O backend em `tarefas-backend/` nao corre no GitHub Pages.

1. Publica o backend noutro servico Node.js.
2. Cria um ficheiro `.env.production` na raiz com:

```env
VITE_API_URL=https://a-tua-api.exemplo.com
```

3. Faz o build e o deploy:

```bash
npm run deploy
```

## Desenvolvimento local

Frontend:

```bash
npm run dev
```

Backend:

```bash
cd tarefas-backend
npm start
```
