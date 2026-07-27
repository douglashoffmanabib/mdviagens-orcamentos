# Backend Hotelbeds — MD Viagens

Pequeno servidor (1 função) que conecta o orçamento dinâmico à **Content API do Hotelbeds/HBX**.
Ele guarda suas chaves com segurança e devolve, por código de hotel, as **fotos**, a
**localização** (lat/lon), o **nome**, as **estrelas** e o **endereço** — que o template usa
para montar o carrossel e o mapa automaticamente.

## Por que existe um backend?
A API do Hotelbeds exige uma assinatura feita com sua **API Key + Secret**. O Secret **não pode**
ficar no site (qualquer visitante veria). Além disso, o Hotelbeds bloqueia chamadas feitas
direto do navegador (CORS). Por isso o fluxo é:

    navegador  →  este backend (assina com o Secret)  →  Hotelbeds  →  volta pro navegador

## Passo a passo (Vercel — grátis)

1. Crie uma conta em https://vercel.com (pode entrar com o GitHub).
2. Suba esta pasta (`backend-hotelbeds/`) como um projeto novo na Vercel
   (arraste a pasta em "Add New → Project", ou conecte um repositório do GitHub com estes arquivos).
3. Em **Settings → Environment Variables**, adicione:

   | Nome                 | Valor                                                        |
   |----------------------|--------------------------------------------------------------|
   | `HOTELBEDS_API_KEY`  | sua API Key da HBX/Hotelbeds                                  |
   | `HOTELBEDS_SECRET`   | seu Secret                                                    |
   | `HOTELBEDS_BASE`     | `https://api.test.hotelbeds.com` (teste) ou `https://api.hotelbeds.com` (produção) |
   | `ALLOWED_ORIGIN`     | (depois) o domínio do seu site, ex.: `https://orcamentos.mdviagens.com` |

4. Clique em **Deploy**. A Vercel te dá uma URL, algo como
   `https://md-orcamentos.vercel.app`.

5. Teste no navegador (troque o código por um hotel real da sua base):
   `https://SEU-PROJETO.vercel.app/api/hotel?code=12345&lang=POR`
   Deve retornar um JSON com `name`, `coordinates`, `images`, etc.

## Ligar no template do orçamento

No arquivo `MD-Viagens-Orcamento-Dinamico.html`, no topo do `<script>`, edite:

```js
const CONFIG = {
  API_BASE: "https://SEU-PROJETO.vercel.app",  // a URL que a Vercel te deu
  hotelCode: "12345"                            // o código do hotel na Hotelbeds
};
```

Pronto: ao abrir a página, o carrossel e o mapa passam a vir **em tempo real** do Hotelbeds.
Se `API_BASE`/`hotelCode` ficarem vazios, o template usa os dados estáticos (modo exemplo).

## Segurança
- Nunca coloque a **API Key/Secret** dentro do HTML nem os envie por chat/e-mail.
- Eles ficam só nas *Environment Variables* da Vercel.
- Depois que estiver no ar, defina `ALLOWED_ORIGIN` para o seu domínio, restringindo quem pode chamar a função.

## Extrator de PDF (api/extract) — o "jogo o PDF → sai o orçamento"

Os PDFs de orçamento são **imagens** (não têm texto), então a leitura é feita por **visão de IA**:
a função `api/extract.js` envia o PDF para a API da Anthropic (o Claude enxerga a página) e devolve
os dados estruturados no formato do template. Funciona para qualquer layout seu (ORÇAMENTO, MDViagens, COTAÇÃO, roteiro).

Passos:
1. Crie uma chave em https://console.anthropic.com → API Keys.
2. Na Vercel, adicione a variável de ambiente `ANTHROPIC_API_KEY` (e opcional `EXTRACT_MODEL`, padrão `claude-sonnet-5`). Redeploy.
3. Abra `https://SEU-PROJETO.vercel.app/extrair.html`, escolha um PDF e clique em **Extrair dados**.
   Vai aparecer o JSON extraído — confira se nome, voos, hotel, datas e o parcelamento saíram certos.

Custo: poucos centavos por PDF (uma chamada de visão por documento).
Segurança: a `ANTHROPIC_API_KEY` fica só na Vercel, nunca no site.

## Fotos + avaliações reais do hotel (api/hotel-photos + api/place-photo)

A partir do NOME do hotel (que vem no PDF), o Google Places encontra o hotel exato e traz
**fotos, localização e avaliações reais**. Assim o carrossel e o mapa ficam corretos sem digitação.

Passos:
1. No Google Cloud (console.cloud.google.com) crie um projeto, ative a **Places API** e gere uma **API Key**.
2. Na Vercel, adicione a variável `GOOGLE_MAPS_API_KEY`. Redeploy.
3. A página do orçamento passa a puxar as fotos/avaliações reais automaticamente.

A chave fica só no servidor (o `place-photo` faz proxy das imagens, sem expor a chave).
A Places API tem cota gratuita generosa; acima dela cobra por consulta.

## Observações
- `language=POR` traz o conteúdo em português quando disponível (cai para inglês se não houver).
- As imagens usam o CDN oficial `photos.hotelbeds.com`. Para thumbnails menores, troque
  `HOTELBEDS_PHOTOS` para `https://photos.hotelbeds.com/giata/small/`.
- Avaliações (estilo TripAdvisor) não fazem parte da Content API do Hotelbeds; se quiser
  avaliações reais depois, dá para somar Google Places como fonte complementar.
