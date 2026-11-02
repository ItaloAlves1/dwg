# Conversor PDF → DWG

Converte desenhos técnicos escaneados (PDF com imagens) em arquivos **DWG** editáveis, com cada folha em um DWG (AutoCAD 2018) separado em camadas:

| Camada | Conteúdo |
|---|---|
| `LINHAS` | Linhas retas, molduras, pontos de ligação (●) |
| `SIMBOLOS` | Contatos, bornes, terra e demais traços |
| `TEXTO` | Textos reconhecidos por OCR, editáveis (inclusive verticais) |
| `TEXTO_REVISAR` | Textos com leitura duvidosa, para conferir |
| `ASBUILT_VERMELHO` / `_LARANJA` / `_VERDE` / `_AZUL` | Marcações à mão do as-built, separadas pela cor |

## Como funciona

```
Navegador ──► Site (Vercel) ──► Supabase ◄── Worker (seu PC Windows)
              login, envio,     Auth, banco     lê a fila, converte
              progresso, ZIP    e arquivos      e devolve os DWG
```

- **`web/`**: site estático hospedado na Vercel. Faz login (Supabase Auth), envia os PDFs, mostra o progresso e baixa os DWG (um por folha ou tudo em ZIP).
- **`supabase/schema.sql`**: tabelas, regras de acesso (cada usuário só vê os próprios arquivos), funções da fila e buckets de armazenamento.
- **`worker/`**: programa que roda no Windows. Busca os PDFs na fila, converte com OCR (Tesseract) e vetorização própria, gera o DWG com o ODA File Converter e envia o resultado ao Supabase.

A conversão **não** roda na Vercel, porque o ODA File Converter é um programa instalado e o OCR é pesado demais para funções serverless. Enquanto o worker estiver desligado, os PDFs enviados ficam na fila e o site mostra "Conversor desligado".

---

## Instalação

### 1. Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Abra **SQL Editor → New query**, cole todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Em **Authentication → URL Configuration**, coloque a URL do site da Vercel (passo 2) em **Site URL** e em **Redirect URLs**. O link de confirmação de e-mail aponta para lá.
4. Anote, em **Project Settings → API**:
   - **Project URL**
   - chave **anon / public** (vai para a Vercel)
   - chave **service_role** (vai **só** para o worker; é secreta)

> **Quer restringir quem pode criar conta?** Em **Authentication → Sign In / Providers**, desative "Allow new users to sign up" depois de criar as contas necessárias, ou convide usuários por **Authentication → Users → Invite**.

### 2. Vercel (site)

1. Em [vercel.com](https://vercel.com) → **Add New → Project** → importe este repositório do GitHub.
2. Framework Preset: **Other**. Não altere Root Directory, Build Command ou Output Directory: tudo já está no `vercel.json`.
3. Em **Environment Variables**, adicione:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = chave anon / public
4. Clique em **Deploy**. Se você instalar a integração oficial Supabase ↔ Vercel, ela cria `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`, que também funcionam.

### 3. Worker (no PC Windows que fará as conversões)

Requisitos:
- **Node.js 20.11 ou mais novo**: [nodejs.org](https://nodejs.org)
- **ODA File Converter** (gratuito): [opendesign.com/guestfiles/oda_file_converter](https://www.opendesign.com/guestfiles/oda_file_converter). Instale normalmente; o worker o encontra sozinho em `C:\Program Files\ODA\`.

Passos:
1. Na pasta `worker`, copie `.env.example` para `.env` e preencha `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
2. Dê dois cliques em **`Iniciar Worker.bat`**. Na primeira vez ele instala as dependências.
3. Deixe a janela aberta. O site passa a mostrar **"Conversor ligado"**.

Você pode rodar o worker em mais de um PC ao mesmo tempo: a fila divide as folhas entre eles sem repetir.

---

## Uso

1. Abra o site, crie a conta (confirme pelo e-mail) e entre.
2. Arraste os PDFs (até 50 MB cada).
3. Acompanhe o progresso; em **Ver folhas** aparecem as prévias, que ampliam ao clicar.
4. **Baixar DWG (.zip)** baixa todas as folhas prontas. Também é possível baixar folha por folha.

Tempo típico: 7 a 12 segundos por folha, com várias folhas em paralelo.

### Converter sem o site (linha de comando)

```bash
cd worker
node convert.mjs "C:/caminho/arquivo.pdf" 20 saida
```

Gera `saida/folha_020.dxf`, as prévias em PNG e `saida/dwg/folha_020.dwg`.

---

## Limitações conhecidas

- Números muito pequenos (bornes) e textos finos às vezes viram traços na camada `SIMBOLOS` em vez de texto.
- Círculos pequenos de terminais cortados por linhas podem sair abertos.
- Logotipos e carimbos viram traços soltos.
- A escala sai no tamanho da folha escaneada (mm); se o original for A3 ou A1, use `SCALE` no AutoCAD.
- O resultado é um ponto de partida que exige revisão, não um desenho pronto.

## Segurança

- A chave **anon** no site é pública por definição; o acesso aos dados é protegido pelo RLS (cada usuário só vê os próprios trabalhos e arquivos).
- A chave **service_role** fica só no `worker/.env`, que não é versionado.
- PDFs, DWG e DXF estão no `.gitignore`: os desenhos são documentos internos e não devem ir para o repositório.
- O ODA File Converter não é distribuído neste repositório; cada PC o instala a partir do site oficial, conforme a licença da Open Design Alliance.
