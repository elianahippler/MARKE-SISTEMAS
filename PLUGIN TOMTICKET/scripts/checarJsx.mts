/**
 * Confere que as telas JSX do plugin ao menos transpilam.
 *
 * JSX-string não passa pelo TypeScript: um parêntese a menos compila o projeto
 * inteiro sem reclamar e só quebra na tela do cliente, depois de instalado.
 * Este script roda o mesmo Babel que o app usa em runtime.
 */
import Babel from "@babel/standalone";
import { TELA_DE_CATEGORIAS } from "../src/ui/telaDeCategorias.ts";
import { REFERENCIA_ATENDENTES, REFERENCIA_DEPARTAMENTOS } from "../src/ui/telaDeReferencia.ts";

const TELAS: Array<[string, string]> = [
  ["telaDeCategorias", TELA_DE_CATEGORIAS],
  ["referenciaAtendentes", REFERENCIA_ATENDENTES],
  ["referenciaDepartamentos", REFERENCIA_DEPARTAMENTOS]
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
