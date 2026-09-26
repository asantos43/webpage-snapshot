# Page Snapshot

**Page Snapshot** é uma extensão para navegadores Chromium (Chrome, Opera, Edge e outros; Manifest V3) que salva a aba que você está vendo como um ZIP. Cada folha de estilo, imagem, fonte e ícone é baixado e a página é reescrita para apontar para as cópias locais: basta descompactar e abrir o `index.html`, a qualquer momento e sem internet.

Ela captura a página **como está na tela agora**, e não como o servidor a enviou: conteúdo gerado por JavaScript, o que você digitou em formulários e canvases entram no snapshot.

Os detalhes técnicos (o que é capturado, de onde vêm os arquivos, limitações e permissões) estão no [README da extensão](page-snapshot-extension/README.md). O histórico completo está no [`CHANGELOG.md`](CHANGELOG.md).

## O que ela faz

- **O DOM ao vivo:** conteúdo inserido por scripts, valores atuais de formulários (senhas nunca são salvas), estado de checkboxes e selects, e `<canvas>` (salvo como imagem).
- **Todos os recursos:** CSS (inclusive `@import`, `url()`, estilos criados por JavaScript), imagens (`srcset`, `<picture>`), fontes, posters de vídeo e áudio/vídeo pequenos.
- **Arquivos que a página já carregou:** lidos direto da aba pelo debugger do navegador, com os mesmos bytes que você viu, inclusive imagens que exigem login. O que faltar é baixado de dentro da aba e depois pela extensão, com limite de 4 downloads por site e novas tentativas em caso de rate limit (HTTP 429/503).
- **Interatividade que continua funcionando offline:** seções recolhidas, acordeões, botões "Expandir tudo" / "Recolher tudo", abas e carrosséis ("Próximo" / "Anterior"), restaurados por um pequeno script local que nunca acessa a rede.
- **Editores de código (Monaco / VS Code):** viram texto comum, rolável e selecionável, com o arquivo completo quando há link de download; os botões "Copy file" e "word wrap" continuam funcionando.
- **Carrosséis:** a extensão percorre cada item na página ao vivo (e a devolve ao estado em que estava) e embute todos no snapshot.
- **Arquivos para download:** links `<a download>` e documentos do mesmo site (`.zip`, `.pdf`, `.csv`…), até 25 arquivos, vão para `assets/`.
- **Texto cortado com "…mais"** por clamp de CSS aparece inteiro.
- **Progresso ao vivo:** uma pequena janela no centro da janela do navegador mostra cada fase com contadores e o arquivo sendo baixado naquele momento, com os botões **OK** e **Cancel** e uma seção **Help**.

## Privacidade: o snapshot nunca acessa a rede

Abrir o `index.html` não faz nenhuma requisição. Os scripts originais da página e os atributos `ping` são removidos, iframes de outros sites (anúncios, telemetria) não são carregados, e qualquer arquivo que não pôde ser salvo tem a referência removida em vez de apontar para o site ao vivo. Links (`<a href>`) continuam levando ao site real quando você está online.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `page-snapshot-extension/` | A extensão (JavaScript puro, sem etapa de build e sem dependências) |
| `tests/` | Smoke test com Playwright num Chromium real |
| `docs/` | Notas de desenvolvimento: ambiente, navegadores, versões, releases e origem do repo |
| `.github/workflows/` | A Action que publica uma release a cada pull request mergeado |

## Instalar

A extensão funciona em navegadores Chromium, como **Google Chrome**, **Opera** e **Microsoft Edge**.

1. Abra a página de extensões: `chrome://extensions` (Chrome), `opera://extensions` (Opera) ou `edge://extensions` (Edge).
2. Ligue o **Modo de desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta `page-snapshot-extension/`.
4. Se quiser, fixe o ícone na barra de ferramentas.

Depois de atualizar o código, recarregue a extensão na mesma página.

### A partir de uma release

Cada versão é publicada em **Releases** no GitHub como `page-snapshot-<versão>.zip`. Baixe, descompacte numa pasta fixa e carregue essa pasta como acima. Para atualizar, substitua o conteúdo da pasta e recarregue a extensão.

## Usar

Clique no botão da barra de ferramentas ou aperte **Alt+Shift+S**. Uma pequena janela abre no centro da janela do navegador, mostra o progresso e, no fim, baixa `<título-da-página>-<AAAAMMDD-HHmm>.zip`.

- **OK** fica disponível quando a captura termina: fecha a janela e volta para a página capturada. **Download again** baixa o mesmo ZIP de novo.
- **Cancel** (ou fechar a janela) interrompe a captura: os carrosséis voltam ao primeiro item e nada é salvo.
- **Help** resume esses pontos na própria janela.

O progresso fica numa janela separada, e não numa aba, de propósito: a página capturada continua sendo a aba visível atrás dela e o navegador não a deixa lenta enquanto os carrosséis são percorridos. Você pode mover a janela de progresso para onde quiser; só não minimize a janela do navegador até a captura terminar.

Descompacte e abra o `index.html`:

```
index.html        a página, com todas as referências apontando para assets/
assets/           CSS, imagens, fontes e ícones
snapshot.json     URL de origem, título, data da captura, cada recurso salvo e cada falha
```

Durante a captura o navegador mostra a barra "Extension started debugging this browser" na aba; ela some quando a captura termina.

## Testes

```sh
cd tests
npm install        # uma vez; o Chromium do Playwright fica em ~/.cache/ms-playwright
npm run smoke      # carrega a extensão e abre as páginas dela
```

## Licença

[MIT](LICENSE)
