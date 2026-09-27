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
- Política de privacidade: o gist público do próximo passo (o link entra aqui e em `README.md`)
- Zip da versão atual: página [Releases](https://github.com/asantos43/webpage-snapshot/releases)
  do repositório (`pagekeep-<versão>.zip`)

## 1. Criar o item

1. No painel, **Add new item** (Adicionar novo item) e envie o zip do release mais recente.
2. A loja cria o item e mostra o **Item ID** (32 letras). Anote: ele vai para o segredo
   `CWS_ITEM_ID` (passo 6) e também é o id que a extensão terá para quem instalar pela loja.

## 2. Store listing (página da loja)

Siga a tabela de [`README.md`](README.md):

- **Description**: cole [`description.en.txt`](description.en.txt).
- **Category**: Productivity → Tools. **Language**: English.
- **Screenshots**: `images/en/screenshot-1.jpg` a `screenshot-5.jpg`, nessa ordem.
- **Small promo tile**: `images/en/small-promo-tile.jpg`. **Marquee** (opcional):
  `images/en/marquee-promo-tile.jpg`.
- **Store icon**: `page-snapshot-extension/icons/icon128.png`.
- Adicione o idioma **Portuguese (Brazil)** e repita com `description.pt_BR.txt` e as imagens de
  `images/pt_BR/`.
- **Support email** (se pedir): asantos35@gmail.com.

## 3. Privacy (práticas de privacidade)

Copie de [`../docs/STORE-POLICY.md`](../docs/STORE-POLICY.md):

- **Single purpose**: o texto da seção "Single purpose".
- **Permission justification**: uma linha para cada permissão da tabela: `activeTab`,
  `scripting`, `debugger`, `offscreen`, `downloads` e `storage`. Não há permissões de host (se o
  painel perguntar por "host permission", a resposta é que não há nenhuma).
- **Remote code**: No.
- **Data usage**: marque *Website content* e *Web history*, nada mais, e as três certificações (não
  vende, não usa para outro fim, não usa para crédito). Nada sai do computador, mas a extensão lê
  o conteúdo e o endereço da página capturada; declarar a mais não gera problema, declarar a
  menos, sim.
- **Privacy policy URL**: o link do gist (próximo passo).

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

## 6. Envio automático das próximas versões

A action de release (`.github/workflows/release.yml`) terá o passo **Send to the Chrome Web
Store**, que usa a API da loja (v2) com a **conta de serviço** do Google Cloud. Enquanto os
segredos não existirem, ele só avisa e não faz nada.

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

A partir daí, cada pull request aceito gera o release no GitHub **e** envia o mesmo zip à loja
para revisão. Pré-lançamentos (opção "prerelease" da execução manual) e pull requests com o rótulo
`no-release` não vão para a loja. Se a loja recusar o pacote, o passo falha e aparece em vermelho
no Actions; o release no GitHub continua publicado.
