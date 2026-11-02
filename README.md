# Conversor PDF → DWG

Converte desenhos técnicos escaneados (PDF com imagens) em arquivos **DWG** (AutoCAD 2018) e **DXF** editáveis, um por folha.

Cada desenho vem separado em camadas:

| Camada | Conteúdo |
|---|---|
| `LINHAS` | Linhas retas, molduras, pontos de ligação (●) |
| `SIMBOLOS` | Contatos, bornes, terra e demais traços |
| `TEXTO` | Textos reconhecidos por OCR, editáveis (inclusive verticais) |
| `TEXTO_REVISAR` | Textos com leitura duvidosa, para conferir |
| `ASBUILT_VERMELHO` / `_LARANJA` / `_VERDE` / `_AZUL` | Marcações à mão do as-built, separadas pela cor |

## Como funciona

```
Navegador de quem usa ──────────────► Supabase ◄────────────── Agente DWG (um PC Windows)
  lê o PDF, OCR, vetoriza,             login, histórico,        quando ligado: baixa os DXF
  gera os DXF (nada sai do PC)         DXF, DWG e prévias       novos, converte com o ODA
          ▲                                                      File Converter e envia o DWG
          │ site estático
       Vercel (seu domínio)
```

- **O DXF não depende de servidor.** Ele é gerado no navegador de quem envia o PDF (pdf.js + Tesseract.js + vetorização própria em Web Workers). O PDF não é enviado para lugar nenhum; só os DXF e as prévias vão para a conta do usuário no Supabase.
- **O DWG é gerado pelo agente** (pasta `agente-dwg/`), que roda escondido num PC Windows e inicia junto com ele. O PC **não precisa ficar ligado o tempo todo**: se estiver desligado, os DXF ficam prontos na hora e os DWG saem quando ele for ligado. O site mostra "Conversor DWG ligado/desligado".
- **É preciso manter a aba aberta** enquanto converte. Se fechar no meio, o trabalho aparece como "interrompido": clique em **Continuar** e escolha o mesmo PDF; ele segue das folhas que faltam.
- **Vercel** só hospeda os arquivos do site (pasta `web/`) no seu domínio.
- **Supabase** guarda as contas (Auth), o histórico (tabelas `jobs` e `pages`) e os arquivos (bucket `resultados`).

Tempo típico: 3 a 4 folhas a cada 10 segundos num PC comum (o PDF de teste, de 100 folhas, levou uns 5 minutos). Na primeira vez, o navegador baixa uns 15 MB de dados do OCR, que ficam em cache.

---

## Instalação

### 1. Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Abra **SQL Editor → New query**, cole todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Em **Project Settings → API**, anote o **Project URL** e a chave **anon / public**.
4. Depois de publicar na Vercel (passo 2), volte em **Authentication → URL Configuration** e coloque a URL do site (o seu domínio) em **Site URL** e em **Redirect URLs**. É para lá que o link de confirmação de e-mail aponta.

> **Quer restringir quem pode criar conta?** Depois de criar as contas necessárias, desative o cadastro em **Authentication → Sign In / Providers** ("Allow new users to sign up"), ou convide pessoas por **Authentication → Users → Invite**.

### 2. Vercel

1. Em [vercel.com](https://vercel.com) → **Add New → Project** → importe este repositório do GitHub.
2. Framework Preset: **Other**. Não altere Build Command nem Output Directory: já estão no `vercel.json`.
3. Em **Environment Variables**, adicione:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = chave anon / public
4. **Deploy**.
5. Para usar seu domínio: **Project → Settings → Domains → Add** e siga as instruções de DNS.

Se você usar a integração oficial Supabase ↔ Vercel, ela cria `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`, que também funcionam.

### 3. Agente DWG (no PC Windows que vai gerar os DWG)

Requisito: **Node.js 20.11 ou mais novo** ([nodejs.org](https://nodejs.org)).

1. Se o seu Supabase foi criado antes desta versão, rode [`supabase/migracao-002-dwg.sql`](supabase/migracao-002-dwg.sql) no SQL Editor (quem roda o `schema.sql` atual já tem tudo).
2. Na pasta `agente-dwg`, dê dois cliques em **`instalar.bat`** e informe a URL do projeto Supabase. Ele:
   - copia o agente para `%LOCALAPPDATA%\ConversorDWG`;
   - baixa o ODA File Converter oficial (gratuito) e confere a assinatura digital;
   - cria o atalho para iniciar junto com o Windows, sem janela.
3. O Bloco de Notas abre o arquivo `.env`: cole a chave **service_role** (Supabase → Project Settings → API Keys) em `SUPABASE_SERVICE_ROLE_KEY=` e salve. Essa chave é secreta e fica só nesse PC.
4. Rode **`instalar.bat`** de novo (ou reinicie o PC) para ligar o agente. O site passa a mostrar "Conversor DWG ligado".

Na pasta `%LOCALAPPDATA%\ConversorDWG`: **`parar.bat`** desliga o agente, **`ver-log.bat`** mostra o registro do que ele fez e `iniciar-oculto.vbs` liga de novo. Para desinstalar, rode `parar.bat`, apague essa pasta e o atalho "Conversor DWG" em `shell:startup`.

### Testar localmente (opcional)

Copie `web/config.example.js` para `web/config.js`, preencha e sirva a pasta `web/` com qualquer servidor estático, por exemplo:

```bash
npx serve web
```

(Abrir o `index.html` direto pelo explorador de arquivos não funciona, porque os Web Workers exigem um servidor.)

---

## Uso

1. Abra o site, crie a conta (confirme pelo e-mail) e entre.
2. Arraste os PDFs. A conversão começa na hora; deixe a aba aberta.
3. Em **Ver folhas** aparecem as prévias, que ampliam ao clicar. Dá para baixar folha por folha.
4. **Baixar DWG (.zip)** baixa todas as folhas já convertidas em DWG; **Baixar DXF (.zip)** baixa os DXF (disponíveis mesmo com o agente desligado).

## Estrutura

```
web/                      site (publicado pela Vercel)
  index.html, style.css, app.js     interface, login, histórico, download
  conversor/conversor.js            orquestra: pdf.js → vetorizador → OCR → vetorizador
  conversor/vetorizador.js          Web Worker: linhas, símbolos, textos, DXF e prévia
  vendor/                           pdf.js e Tesseract.js (Apache-2.0)
agente-dwg/               agente do PC: DXF → DWG com o ODA File Converter, instalador
supabase/schema.sql       tabelas, RLS e bucket (migracao-002-dwg.sql: atualização para DWG)
scripts/gerar-config.mjs  gera web/config.js no build da Vercel
```

## Limitações conhecidas

- Números muito pequenos (bornes) e textos finos às vezes viram traços na camada `SIMBOLOS` em vez de texto.
- Círculos pequenos de terminais cortados por linhas podem sair abertos.
- Logotipos e carimbos viram traços soltos.
- A escala sai no tamanho da folha escaneada (mm); se o original for A3 ou A1, use `SCALE` no AutoCAD.
- PDFs muito grandes usam bastante memória; em PCs com pouca RAM, converta um PDF por vez.
- O resultado é um ponto de partida que exige revisão, não um desenho pronto.

## Segurança

- A chave **anon** no site é pública por definição; o acesso aos dados é protegido pelo RLS (cada usuário só vê os próprios trabalhos e arquivos).
- O PDF original nunca sai do computador de quem converte.
- PDFs, DWG e DXF estão no `.gitignore`: os desenhos são documentos internos e não devem ir para o repositório.
