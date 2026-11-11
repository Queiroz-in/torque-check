/*
 * listas-padrao.js — listas padrão de parafusos, uma por modelo de caminhão.
 *
 * São os itens de aperto do checklist de inspeção de entrega. Os torques estão
 * como "?" (a definir): o checklist não traz os valores, que ficam no documento
 * de serviço de cada modelo. Enquanto houver "?", o app não deixa iniciar a
 * inspeção com aquela lista.
 *
 * ATENÇÃO: este repositório é público. Confirme na empresa se os valores de
 * torque podem ser publicados aqui; se não puderem, preencha-os só no aparelho
 * (Configurações → Listas de parafusos → Editar).
 *
 * Formato de cada linha:   Nome : torque
 *   torque:  90   ·   90 ± 5   ·   85 a 95   ·   ?  (a definir)
 *   "×10" no fim do nome cria 10 itens (uma foto por porca).
 *   Linhas começando com # são comentários.
 * Confira o número de porcas por roda e de eixos de cada versão do veículo.
 */
window.LISTAS_PADRAO = [
  {
    id: 'atego',
    nome: 'Atego',
    texto: `# Rodas - uma foto por porca
Roda dianteira esquerda - porca ×10 : ?
Roda dianteira direita - porca ×10 : ?
Roda traseira esquerda - porca ×10 : ?
Roda traseira direita - porca ×10 : ?
# Cabine
Molas dianteiras da cabine - fixação ao chassi : ?
Mancal da suspensão dianteira da cabine : ?
Suspensão traseira da cabine - fixação no chassi : ?
# Transmissão e suspensão
Cruzeta/flange das árvores de transmissão : ?
Grampos das molas (suspensão metálica) : ?
`,
  },
  {
    id: 'axor',
    nome: 'Axor',
    texto: `# Rodas - uma foto por porca
Roda dianteira esquerda - porca ×10 : ?
Roda dianteira direita - porca ×10 : ?
Roda traseira esquerda - porca ×10 : ?
Roda traseira direita - porca ×10 : ?
# Cabine
Mancal da suspensão dianteira da cabine : ?
Suspensão traseira da cabine - fixação no chassi : ?
# Transmissão e suspensão
Cruzeta/flange das árvores de transmissão : ?
Grampos das molas (suspensão metálica) : ?
`,
  },
  {
    id: 'atron',
    nome: 'Atron',
    texto: `# Rodas - uma foto por porca
Roda dianteira esquerda - porca ×10 : ?
Roda dianteira direita - porca ×10 : ?
Roda traseira esquerda - porca ×10 : ?
Roda traseira direita - porca ×10 : ?
# Cabine
Suspensão dianteira e traseira da cabine - fixação no chassi : ?
# Transmissão e suspensão
Cruzeta/flange das árvores de transmissão : ?
Grampos das molas (suspensão metálica) : ?
`,
  },
  {
    id: 'actros',
    nome: 'Actros (novo)',
    texto: `# Rodas - uma foto por porca
Roda dianteira esquerda - porca ×10 : ?
Roda dianteira direita - porca ×10 : ?
Roda traseira esquerda - porca ×10 : ?
Roda traseira direita - porca ×10 : ?
# Suspensão
Braços triangulares - fixação no chassi e no eixo : ?
Grampos das molas (suspensão metálica) : ?
# Transmissão
Cruzeta/flange das árvores de transmissão : ?
# Combustível (tipos 963 e 964)
Cintas de fixação do reservatório de combustível : ?
`,
  },
];
