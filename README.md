# Torque Check — conferência de aperto com foto do torquímetro

Protótipo de app (web, roda no navegador do celular) para a inspeção de aperto de
parafusos de um veículo novo. Em vez de o inspetor só marcar um "check" na lista,
o app **pede uma foto do torquímetro**, lê o valor e **só marca o item como
conferido se o valor estiver dentro da faixa especificada** na planilha. Depois
disso, avança para o próximo parafuso.

Funciona com:

- **torquímetro digital** (visor de números de 7 segmentos);
- **torquímetro analógico de relógio** (mostrador redondo com ponteiro).

A leitura é feita **só com visão computacional clássica**, no próprio celular:
sem inteligência artificial, sem rede neural, sem internet e sem enviar fotos
para lugar nenhum.

## Como funciona

1. O inspetor informa a matrícula, o chassi/VIN, o torquímetro e o **modelo do caminhão**,
   que define a lista de parafusos (veja *Listas de parafusos*).
2. Para cada parafuso, na ordem da lista, o app mostra o torque nominal e a faixa aceita.
3. O inspetor aperta o parafuso e fotografa o torquímetro: o visor dentro do
   retângulo verde (digital) ou o mostrador dentro do círculo verde (analógico).
4. O app lê o valor e decide:

| Resultado | O que acontece |
|---|---|
| ✅ Dentro da faixa | Item marcado como conferido, o app avança sozinho para o próximo |
| ❌ Fora da faixa | Não marca. Pede para refazer o aperto e fotografar de novo |
| ⚠️ Ilegível / leitura duvidosa | Não marca. Pede uma nova foto |

5. No fim, o app gera um relatório com o valor lido, o horário e a foto de cada
   parafuso, além de todas as tentativas reprovadas e alertas. Dá para exportar em
   CSV, em JSON (com as fotos) ou imprimir/salvar em PDF.

## Como o valor é reconhecido

### Digital (7 segmentos) — `leitor.js`

1. Converte o recorte do visor para tons de cinza e binariza (limiar de Otsu e
   limiar local, para aguentar reflexo parcial), testando dígito escuro em fundo
   claro e o contrário.
2. Remove a moldura do aparelho e endireita os dígitos inclinados (itálico típico de LCD).
3. Separa os dígitos por componentes conexos e acha o ponto decimal (bolinha pequena na linha de base).
4. Classifica cada dígito pelo **padrão dos 7 segmentos acesos** (a–g), comparando com a tabela de 0 a 9.
5. Se as variações de binarização discordam, a confiança cai e o app pede outra
   foto em vez de arriscar um número.

### Analógico de relógio — `leitor-analogico.js`

Cada **modelo** de torquímetro é **calibrado uma vez** (Configurações → Torquímetros
analógicos, ou o botão na tela inicial):

- informe o início e o fim da escala, a menor divisão e a cor do ponteiro que indica o valor;
- fotografe o mostrador e **toque no traço do início e no traço do fim da escala**.

O app guarda os ângulos desses dois traços e uma "assinatura" da escala (o padrão
de traços e números em volta do mostrador). Na inspeção, para cada foto:

1. **Acha o mostrador**: transformada de Hough para círculos (votos guiados pelo
   gradiente de Sobel), refinada por ajuste de círculo por mínimos quadrados.
2. **Corrige a rotação da foto**: compara a assinatura da escala com a da
   calibração por correlação cruzada circular. Assim, o celular pode estar um pouco
   girado (testado até ±12°) sem errar a leitura.
3. **Acha o ponteiro**: para cada ângulo, lança um raio do centro para fora e mede
   quanto dele tem a cor do ponteiro. O ponteiro é um traço contínuo e cobre o raio
   quase inteiro; números e traços da escala cobrem só um pedaço.
4. **Converte o ângulo em N·m** pela calibração e arredonda para 1/5 da menor divisão.

Detalhes:

- **Ponteiro de arraste (memória)**: muitos torquímetros de relógio têm um segundo
  ponteiro, que fica parado no maior valor atingido. Com a opção marcada, o app lê
  esse ponteiro, então o inspetor pode soltar a ferramenta antes de fotografar.
  **Zere o ponteiro de arraste antes de cada aperto.**
- Uma foto de **outro modelo de torquímetro** é recusada: a assinatura da escala não bate.
- Fotos tortas em perspectiva (mostrador oval), sem o mostrador inteiro ou com o
  ponteiro escondido são recusadas com pedido de nova foto.
- Na tela de inspeção, uma marca verde **“0”** no círculo mostra onde deve ficar o
  zero do mostrador.
- A inspeção só começa se a escala do torquímetro cobrir as faixas de todos os itens da lista.

### Torquímetro de estalo

O torquímetro de estalo **não mostra o torque aplicado**: a escala no cabo indica só o
valor *regulado*, e o estalo não deixa marca visível. Uma foto dele não comprova o
aperto, por isso esse tipo não está no app. Para esse caso, as alternativas são
torquímetros de estalo com registro eletrônico, ou passar a conferência para um
torquímetro de relógio ou digital com memória de pico.

## Medidas contra "marcar sem fazer"

- **Só câmera ao vivo.** Não há opção de escolher foto da galeria.
- **Ordem obrigatória.** Os itens são feitos na sequência; não dá para pular.
- **Valor tem que bater.** O check só acontece com o valor lido dentro da faixa.
- **Foto parecida gera alerta.** O app guarda um "hash perceptual" do entorno do
  torquímetro (a peça e o parafuso ao redor). Uma foto muito parecida com a de outro
  item fica marcada como alerta no relatório. Fotos das porcas de uma mesma roda podem
  ser quase iguais e não geram alerta.
- **Tempo entre apertos.** Conferências mais rápidas que o mínimo configurado
  (padrão 5 s) ficam marcadas como alerta.
- **Tudo fica registrado.** Cada tentativa, inclusive as reprovadas, guarda a
  foto, o valor lido, a confiança da leitura e o horário.
- **Liberação do supervisor.** Se a foto não puder ser lida depois de algumas
  tentativas, o supervisor pode liberar o item com PIN, valor e motivo. Isso aparece
  separado no relatório.
- **Configurações protegidas.** Durante uma inspeção, mudar as regras exige o PIN do supervisor.
- **Integridade do relatório.** O relatório exportado vem com um código SHA-256 do conteúdo.

## Listas de parafusos (uma por modelo de caminhão)

No início da inspeção, o inspetor escolhe o **modelo do caminhão**, e o app usa a lista
de parafusos desse modelo. Cada item da lista é uma foto do torquímetro.

### Listas padrão

O app já vem com uma lista para **Atego**, **Axor**, **Atron** e **Actros (novo)**, com
os itens de aperto do checklist de inspeção de entrega (porcas das rodas, fixações da
suspensão da cabine, cruzeta/flange das árvores de transmissão, grampos das molas,
braços triangulares, cintas do reservatório de combustível). Elas ficam no arquivo
`listas-padrao.js`, que dá para editar direto no GitHub.

- **Os torques vêm como `?` (a definir)**, porque o checklist não traz os valores; eles
  estão no documento de serviço de cada modelo. Enquanto uma lista tiver `?`, o app não
  inicia inspeção com ela e mostra quais itens faltam.
- **Uma foto por porca:** `Roda dianteira esquerda - porca ×10 : 450 ± 20` vira 10 itens
  (“porca 1 de 10” … “porca 10 de 10”). Confira o número de porcas por roda e de eixos de
  cada versão do veículo.
- **Este repositório é público.** Antes de escrever os torques em `listas-padrao.js`,
  confirme na empresa se esses valores podem ser publicados. Se não puderem, preencha-os só
  no aparelho (veja abaixo): o que é editado no aparelho não vai para o GitHub.

### Editar, criar e excluir listas no aparelho

Em **Configurações → Listas de parafusos**: **Editar** uma lista, **Nova lista** ou
**Excluir**. Editar uma lista padrão muda só aquele aparelho (dá para voltar ao padrão
depois). Formato, um parafuso por linha:

```
Nome do parafuso : torque
```

- Só o torque (`90`): a faixa aceita usa a **tolerância padrão** (10%, em “Regras”).
- Faixa própria: `90 ± 5` (ou `90 +- 5`, `90 ± 5%`) ou `85 a 95` (ou `85-95`).
- `?` = torque ainda não definido.
- `×10` (ou `x10`) no fim do nome = 10 itens, uma foto cada.
- Unidade (`Nm`, `N·m`) opcional; vírgula ou ponto decimal; linhas com `#` são comentários.
- Enquanto você digita, o app mostra a faixa de cada linha ou o erro com o número da linha.
- **Carregar arquivo .txt**, **Baixar modelo .txt** e **Baixar esta lista** também estão lá.
  Veja `modelo-lista-parafusos.txt`.

Na tela inicial, **Usar outro arquivo só nesta inspeção** aceita um `.txt` nesse formato
ou uma planilha **CSV** do Excel (separada por ponto e vírgula) com as colunas
`item; descricao; torque_nm; min_nm; max_nm`, como em `exemplo-planilha.csv` (valores fictícios).

Durante uma inspeção, mudar as listas (ou qualquer configuração) exige o PIN do supervisor,
e a inspeção em andamento não é afetada: ela guarda a lista com que começou.

## Como rodar

O navegador só libera a câmera em páginas **https://** (ou em `localhost`).

- **GitHub Pages:** com o Pages ativado no repositório, o app fica em
  `https://<usuario>.github.io/<repositorio>/`.
- **No computador, para testar:** na pasta do projeto, rode `python3 -m http.server 8000`
  e abra `http://localhost:8000`.

Não há instalação, servidor nem dependência externa: são só `index.html`, `app.js`,
`leitor.js` e `leitor-analogico.js`. Depois de aberto, funciona sem internet. O
progresso e as calibrações ficam salvos no aparelho; se o app fechar no meio, a
inspeção continua de onde parou.

## Como foi testado

Com imagens geradas por computador, simulando fotos de celular:

- **Digital:** 10 visores de 7 segmentos (LCD e LED, com desfoque, ruído, reflexo,
  inclinação e perspectiva): 10/10 lidos certo. No caso com reflexo forte, a
  confiança cai e o app pede outra foto.
- **Analógico:** 3 modelos de mostrador (330°, 300° e 270° de escala; ponteiro
  vermelho e preto), 75 fotos com valor, rotação (±12°), deslocamento, distância,
  desfoque, ruído e iluminação desigual sorteados: nenhuma leitura errada aceita;
  erro máximo de 0,28 da menor divisão nas aceitas. Fotos de outro modelo de
  torquímetro: todas recusadas.
- **Fluxo completo** com câmera simulada, nos dois tipos.

## Limitações e próximos passos

Isto é um protótipo. Antes de usar de verdade:

1. **Testar com fotos reais** dos torquímetros usados na linha. Fotos reais têm
   reflexo no vidro do mostrador, sombra, foco e ângulos que as imagens sintéticas
   não cobrem totalmente. Os limites de confiança podem precisar de ajuste.
2. **Visores digitais que não são de 7 segmentos** (matriz de pontos, tela gráfica)
   não são lidos. Dá para incluir, com um classificador de padrões próprio para a fonte do aparelho.
3. **Mostradores com escala dupla** (N·m e lbf·ft) funcionam, desde que a calibração use
   os traços da escala em N·m. Mostradores com zero no meio (aperto nos dois sentidos) não são suportados.
4. **A foto prova o valor no torquímetro, não o parafuso.** Alguém mal-intencionado
   ainda pode apertar um parafuso e fotografar várias vezes. As medidas acima
   dificultam e deixam rastro, mas não eliminam isso. Ideias para fechar essa brecha:
   - etiqueta com **QR code em cada ponto de aperto**, lida na mesma foto;
   - **torquímetros conectados** (Bluetooth/Wi-Fi), que mandam o valor e o horário
     direto para o sistema sem foto. Muitas montadoras já usam ferramentas assim nas
     estações de aperto; vale perguntar o que a planta já tem.
5. **Relatório só no celular.** Em produção, o relatório deveria ir para um servidor da empresa.
6. **Unidade.** O app assume N·m, a mesma unidade da planilha.
