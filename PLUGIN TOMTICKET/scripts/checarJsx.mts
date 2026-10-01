/**
 * Confere que as telas JSX do plugin ao menos transpilam.
 *
 * JSX-string não passa pelo TypeScript: um parêntese a menos compila o projeto
 * inteiro sem reclamar e só quebra na tela do cliente, depois de instalado.
 * Este script roda o mesmo Babel que o app usa em runtime.
 */
import Babel from "@babel/standalone";
import { TELA_DE_CATEGORIAS } from "../src/ui/telaDeCategorias.ts";
import { TELA_DE_ATENDENTES, TELA_DE_FILAS } from "../src/ui/telaDeDePara.ts";
import { BOTAO_FINALIZAR, TELA_DE_IA } from "../src/ui/resolverTomTicket.ts";
import { TELA_DE_DIAGNOSTICO } from "../src/ui/telaDeDiagnostico.ts";

const TELAS: Array<[string, string]> = [
  ["telaDeCategorias", TELA_DE_CATEGORIAS],
  ["telaDeAtendentes", TELA_DE_ATENDENTES],
  ["telaDeFilas", TELA_DE_FILAS],
  ["botaoFinalizar", BOTAO_FINALIZAR],
  ["telaDeIa", TELA_DE_IA],
  ["telaDeDiagnostico", TELA_DE_DIAGNOSTICO]
];

let falhou = false;

for (const [nome, jsx] of TELAS) {
  try {
    // Mesmo embrulho do motor do app: corpo de (React, props) => JSX.
    Babel.transform(`(function (React, props) { ${jsx} })`, { presets: ["react"] });
    console.log(`ok   ${nome}`);
  } catch (err: any) {
    falhou = true;
    console.error(`FALHA ${nome}: ${err.message}`);
  }
}

if (falhou) process.exit(1);
