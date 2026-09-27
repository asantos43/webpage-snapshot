# PageKeep — Privacy policy

*Last updated: 2026-09-27 (the option to load the whole page). Published at https://gist.github.com/asantos43/a0566af48d0894dc44b72bee43b22da8. Português abaixo.*

PageKeep is a browser extension by Anderson Santos (asantos35@gmail.com). It saves the page in the
tab you choose as a ZIP file that opens offline.

## What the developer receives

**Nothing.** The extension has no server, no account, no analytics, no telemetry and no
advertising. The developer never receives, collects, sells or shares any data about you or the
pages you save.

## What the extension reads, and where it goes

- **The page you capture.** When you open PageKeep's popup on a tab (by clicking its icon or
  pressing Alt+Shift+S), it reads that page as it is on screen: its content, styles, images and
  fonts, the current values of its forms, its canvases and code editors, and every item of its
  carousels. With the option "Load the whole page first" (on unless you turn it off), it first
  scrolls through the page and presses its "Load more" buttons, as you could, so that content that
  only appears then is saved too. Password fields are always left empty. It does this only on that tab and only while
  the capture runs.
- **All of it goes only into the ZIP file** saved in your Downloads folder, on your computer. The
  ZIP also records the page's address and title and the time of the capture
  (`snapshot.json`). What you do with the file afterwards is up to you.
- **The files the page already loaded** are read from the tab through the browser's debugger, which
  the browser shows with a bar while the capture runs; it is attached only to that tab and only
  for the capture.

## What goes over the network

Only requests for the captured page's **own files** (images, styles, fonts, downloads it offers)
that the tab had not already loaded, made by the tab itself to the servers that page already uses,
as when you browse it. Nothing else is sent anywhere, and nothing is sent to the developer. The
saved copy makes no request at all when you open it.

## What stays in your browser

While a capture is running or its result is on screen, its progress (the page's address, the
steps, the file name, what could not be saved) is kept in the browser's session storage, so the
popup can show it when reopened. It is deleted when you press OK or Cancel, or when the browser
quits; a finished capture is also deleted when its tab closes.

The extension's only setting, whether the popup's option "Load the whole page first" is on, is kept
in the browser's local storage on this computer (not synced). The extension keeps no history.

## Limited Use

The use of information received from the browser APIs adheres to the Chrome Web Store User Data
Policy, including its Limited Use requirements: data is used only to provide the extension's single
purpose (saving the page you chose), is not transferred to anyone, is not used for advertising,
credit or any unrelated purpose, and no human reads it.

## Contact

Questions: asantos35@gmail.com.

---

# PageKeep — Política de privacidade

*Atualizada em 2026-09-27.*

O PageKeep é uma extensão de navegador de Anderson Santos (asantos35@gmail.com). Ele salva a página
da aba que você escolher num arquivo ZIP que abre offline.

## O que o desenvolvedor recebe

**Nada.** A extensão não tem servidor, conta, análise de uso, telemetria nem publicidade. O
desenvolvedor nunca recebe, coleta, vende ou compartilha dados sobre você ou sobre as páginas que
você salva.

## O que a extensão lê, e para onde vai

- **A página que você captura.** Quando você abre o popup do PageKeep numa aba (clicando no ícone
  ou apertando Alt+Shift+S), ele lê essa página como ela está na tela: o conteúdo, os estilos, as
  imagens e as fontes, os valores atuais dos formulários, os canvases e editores de código, e todos
  os itens dos carrosséis. Com a opção "Carregar a página inteira antes" (ligada, a menos que você
  desligue), ele primeiro rola a página até o fim e aperta os botões "Carregar mais", como você
  faria, para salvar também o conteúdo que só aparece assim. Campos de senha ficam sempre vazios. Isso acontece só nessa aba e só
  enquanto a captura roda.
- **Tudo isso vai apenas para o arquivo ZIP** salvo na sua pasta de Downloads, no seu computador. O
  ZIP também registra o endereço e o título da página e o horário da captura (`snapshot.json`). O
  que você faz com o arquivo depois é decisão sua.
- **Os arquivos que a página já carregou** são lidos da aba pelo depurador do navegador, que o
  navegador indica com uma barra enquanto a captura roda; ele fica conectado só a essa aba e só
  durante a captura.

## O que passa pela rede

Só os pedidos dos **arquivos da própria página capturada** (imagens, estilos, fontes, downloads
que ela oferece) que a aba ainda não tinha carregado, feitos pela própria aba aos servidores que
essa página já usa, como quando você a visita. Nada mais é enviado a lugar nenhum, e nada é enviado
ao desenvolvedor. A cópia salva não faz nenhuma requisição quando você a abre.

## O que fica no seu navegador

Enquanto uma captura roda ou o resultado dela está na tela, o andamento (o endereço da página, as
etapas, o nome do arquivo, o que não pôde ser salvo) fica no armazenamento de sessão do navegador,
para o popup mostrá-lo quando for reaberto. Ele é apagado quando você aperta OK ou Cancelar, ou
quando o navegador é encerrado; uma captura terminada também é apagada quando a aba dela é fechada.

A única configuração da extensão, se a opção "Carregar a página inteira antes" do popup está
ligada, fica no armazenamento local do navegador, neste computador (não é sincronizada). A extensão
não guarda histórico.

## Uso limitado

O uso das informações recebidas pelas APIs do navegador segue a Política de Dados do Usuário da
Chrome Web Store, incluindo os requisitos de Uso Limitado: os dados servem só à finalidade única da
extensão (salvar a página que você escolheu), não são transferidos a ninguém, não são usados para
publicidade, crédito ou qualquer outro fim, e nenhuma pessoa os lê.

## Contato

Dúvidas: asantos35@gmail.com.
