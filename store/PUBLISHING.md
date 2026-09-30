# Publicar na Chrome Web Store (item Privado)

Passo a passo para colocar o PageKeep na loja como **Privado** (só as contas Google que você
autorizar veem e instalam) e deixar as próximas versões irem para a loja sozinhas a cada merge. O
que colar em cada campo está em [`README.md`](README.md); as respostas de privacidade e
permissões, em [`../docs/STORE-POLICY.md`](../docs/STORE-POLICY.md).

A conta de desenvolvedor é a mesma da TabWatcher & Clicker, que ocupa a primeira das duas vagas;
o PageKeep ocupa a segunda. Uma recusa por política conta contra a conta inteira, então confira o
checklist de `STORE-POLICY.md` antes de enviar (`npm run smoke`, `npm run carousel` e
`npm run store-policy` em `tests/` passam em todo release).

Links que você vai usar:

- Painel de desenvolvedor: https://chrome.google.com/webstore/devconsole
- Política de privacidade (gist público): https://gist.github.com/asantos43/a0566af48d0894dc44b72bee43b22da8
- Zip da versão atual: página [Releases](https://github.com/asantos43/webpage-snapshot/releases)
  do repositório (`pagekeep-<versão>.zip`)

## 1. Criar o item

1. No painel, **Add new item** (Adicionar novo item) e envie o zip do release mais recente.
2. A loja cria o item e mostra o **Item ID** (32 letras). Anote: ele vai para o segredo
   `CWS_ITEM_ID` (passo 6) e também é o id que a extensão terá para quem instalar pela loja.

## 2. Store listing (página da loja)

Siga a tabela de [`README.md`](README.md):

- **Description**: cole [`description.en.txt`](description.en.txt). Ela explica as duas formas de
  guardar, `.zip` e `.wsnp` (um contêiner assinado: a página e cada arquivo dela num só ZIP, com um
  manifesto de SHA-256), e diz "um visualizador de .wsnp" sem citar nenhum programa, porque a loja
  não deve prometer o que ainda não foi lançado. O **resumo** vem do manifesto (`ext_description`)
  e também cita `.wsnp`.
- **Category**: Productivity → Tools. **Language**: English.
- **Screenshots**: `images/en/screenshot-1.jpg` a `screenshot-5.jpg`, nessa ordem. Desde a versão
  1.6.0 elas mostram a escolha **Salvar como** com `.wsnp` marcado (a quinta explica `.zip` e
  `.wsnp`); num item que já existe na loja, **troque** as cinco imagens, o tile pequeno e o
  marquee no painel, porque a loja não as atualiza sozinha com o pacote.
- **Small promo tile**: `images/en/small-promo-tile.jpg`. **Marquee** (opcional):
  `images/en/marquee-promo-tile.jpg`.
- **Store icon**: `page-snapshot-extension/icons/icon128.png`.
- Adicione o idioma **Portuguese (Brazil)** e repita com `description.pt_BR.txt` e as imagens de
  `images/pt_BR/`.
- **Support email** (se pedir): asantos35@gmail.com.

## 3. Privacy (práticas de privacidade)

Copie de [`../docs/STORE-POLICY.md`](../docs/STORE-POLICY.md):

- **Single purpose**: o texto da seção "Single purpose" (agora cita o `.wsnp`; se o item já existe,
  troque o texto no painel).
- **Permission justification**: uma linha para cada permissão da tabela: `activeTab`,
  `scripting`, `debugger`, `offscreen`, `downloads` e `storage`. Não há permissões de host (se o
  painel perguntar por "host permission", a resposta é que não há nenhuma).
- **Remote code**: No.
- **Data usage**: marque *Website content* e *Web history*, nada mais, e as três certificações (não
  vende, não usa para outro fim, não usa para crédito). Nada sai do computador, mas a extensão lê
  o conteúdo e o endereço da página capturada; declarar a mais não gera problema, declarar a
  menos, sim.
- **Privacy policy URL**: https://gist.github.com/asantos43/a0566af48d0894dc44b72bee43b22da8

A permissão `debugger` costuma levar a uma revisão mais demorada. A justificativa está pronta em
`STORE-POLICY.md`: ela é usada só na aba escolhida, só durante a captura, com a barra do navegador
visível, e evita pedir acesso a todos os sites.

## 4. Distribution (distribuição)

- **Visibility**: **Private**.
- **Testers** (trusted testers): os e-mails das contas Google que podem instalar. Quem não estiver
  na lista não vê a página.
- **Regions**: todas.

## 5. Enviar para revisão

**Submit for review**. A revisão costuma levar de horas a alguns dias (com `debugger`, pode ser
mais). Depois de aprovada, os testadores instalam pelo link da página do item, com um clique, e
recebem as atualizações sozinhos.

## 6. Envio das próximas versões à loja

A action de release (`.github/workflows/release.yml`) tem o passo **Send to the Chrome Web
Store**, que roda `.github/scripts/publish-to-chrome-web-store.sh` (o mesmo script da TabWatcher)
com a API da loja (v2) e a **conta de serviço** do Google Cloud. Enquanto os segredos não
existirem, ele só avisa e não faz nada. O script é testado a cada release contra uma loja falsa
local (`tests/publish-script.mjs`), já que a loja de verdade só responde com os segredos reais.

A conta de serviço é a mesma da TabWatcher & Clicker (a loja aceita uma por editor), então não é
preciso criar outra no Google Cloud nem no painel. Neste repositório, `CWS_PUBLISHER_ID` e
`CWS_SERVICE_ACCOUNT_KEY` têm os mesmos valores do outro; só `CWS_ITEM_ID` muda. Grave os três
pelo terminal depois de criar o item (o `!` roda o comando aqui, e a chave vai direto do arquivo
para o GitHub):

```
! gh secret set CWS_ITEM_ID --body "<item id do PageKeep>"
! gh secret set CWS_PUBLISHER_ID --body "<publisher id>"
! gh secret set CWS_SERVICE_ACCOUNT_KEY < <arquivo-da-chave>.json
```

Se o arquivo `.json` da chave não estiver mais com você, crie uma chave nova na mesma conta de
serviço (Google Cloud → IAM & Admin → Service accounts → a conta → Keys → Add key → JSON), grave-a
nos dois repositórios e apague o arquivo em seguida. O `.json` é uma senha: nunca envie para
ninguém nem coloque no repositório.

Cada pull request aceito gera o release no GitHub, mas **só vai para a loja quando você pedir**:

- **Junto com o release:** coloque o rótulo `store` no pull request antes do merge (ou, na execução
  manual da action **Release**, marque a opção `store`).
- **Um release já publicado:** Actions → **Send to the Chrome Web Store** → Run workflow, com a
  versão (vazio = o último release). Útil para esperar a revisão anterior terminar.

Pré-lançamentos e pull requests com o rótulo `no-release` nunca vão para a loja. Se a loja recusar
o pacote (por exemplo, enquanto outra versão ainda está em revisão), o passo falha em vermelho no
Actions, com a mensagem da loja; o release no GitHub continua publicado e pode ser enviado depois
pela action **Send to the Chrome Web Store**.

## Quando o `PRIVACY.md` mudar

Atualize o gist, para a loja mostrar o mesmo texto:

```
gh gist edit a0566af48d0894dc44b72bee43b22da8 --filename PRIVACY.md PRIVACY.md
```
