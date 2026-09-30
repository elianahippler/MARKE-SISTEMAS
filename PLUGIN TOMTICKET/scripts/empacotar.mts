/**
 * Monta o `build-context.tar.gz` que o Portainer recebe para gerar a imagem.
 *
 * Existe porque este plugin mora FORA do monorepo, e o Dockerfile espera o
 * layout de lá: `packages/plugin-sdk` ao lado de `plugins/plugin-tomticket`.
 * O script remonta esse layout num diretório temporário e o compacta.
 *
 * Três correções acontecem no caminho, e todas quebram o build se faltarem:
 * o `package.json` aponta o SDK por caminho absoluto do Windows (aqui vira o
 * relativo do monorepo); o `package-lock.json` guarda esse mesmo caminho
 * absoluto (em Linux o npm install falha, então ele sai do pacote); e o
 * Portainer, no build por Upload (2.39.2), não tem campo para apontar o
 * Dockerfile dentro do tar — só usa `./Dockerfile` na raiz. Por isso uma
 * cópia dele vai solta na raiz do pacote, além da que já está em
 * `plugins/plugin-tomticket/` (mantida para quem builda via `docker build -f`
 * direto, como no teste local).
 *
 * Fica UM arquivo por versão em `releases/` (lido de `package.json`), porque
 * não há git aqui — sem isso, cada rodada sobrescrevia a anterior e não dava
 * pra voltar a uma versão já publicada (aconteceu com a 0.1.1: o pacote dela
 * já tinha sumido quando precisou). `build-context.tar.gz` na raiz continua
 * existindo, como cópia da versão mais recente — é nele que o INSTALACAO.md
 * manda enviar ao Portainer.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const RAIZ_PLUGIN = path.resolve(import.meta.dirname, "..");
const SDK = "C:/markedesk-ng-main/markedesk-ng-main/packages/plugin-sdk";
const SAIDA = path.join(RAIZ_PLUGIN, "build-context.tar.gz");

const { version } = JSON.parse(fs.readFileSync(path.join(RAIZ_PLUGIN, "package.json"), "utf8"));
const PASTA_RELEASES = path.join(RAIZ_PLUGIN, "releases");
const SAIDA_VERSIONADA = path.join(PASTA_RELEASES, `plugin-tomticket-${version}.tar.gz`);

/** Não entram no pacote: são gerados no build ou específicos da máquina. */
const IGNORAR = new Set(["node_modules", "dist", "data", ".git", "build-context.tar.gz"]);

function copiar(origem: string, destino: string, ignorarTambem: string[] = []): void {
  const ignorar = new Set([...IGNORAR, ...ignorarTambem]);
  fs.mkdirSync(destino, { recursive: true });
  for (const item of fs.readdirSync(origem, { withFileTypes: true })) {
    if (ignorar.has(item.name)) continue;
    const de = path.join(origem, item.name);
    const para = path.join(destino, item.name);
    if (item.isDirectory()) copiar(de, para, ignorarTambem);
    else fs.copyFileSync(de, para);
  }
}

if (!fs.existsSync(SDK)) {
  console.error(`SDK não encontrado em ${SDK}. Ajuste a constante SDK neste script.`);
  process.exit(1);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tomticket-ctx-"));

try {
  // `docs` traz sete projetos de exemplo, cada um com o próprio lock — nada
  // disso é usado no build, e só engorda o que se envia pelo navegador.
  copiar(SDK, path.join(temp, "packages", "plugin-sdk"), ["docs"]);
  copiar(RAIZ_PLUGIN, path.join(temp, "plugins", "plugin-tomticket"));

  const pacote = path.join(temp, "plugins", "plugin-tomticket", "package.json");
  fs.writeFileSync(
    pacote,
    fs.readFileSync(pacote, "utf8").replace(`file:${SDK}`, "file:../../packages/plugin-sdk"),
    "utf8"
  );

  for (const lock of [
    path.join(temp, "plugins", "plugin-tomticket", "package-lock.json"),
    path.join(temp, "packages", "plugin-sdk", "package-lock.json")
  ]) {
    fs.rmSync(lock, { force: true });
  }

  // Cópia solta na raiz: é nela que o Portainer (build por Upload) bate por
  // padrão, sem campo para apontar outro caminho. O `docker build -f` local
  // continua livre para usar a de dentro de plugins/plugin-tomticket/.
  fs.copyFileSync(
    path.join(temp, "plugins", "plugin-tomticket", "Dockerfile"),
    path.join(temp, "Dockerfile")
  );

  fs.mkdirSync(PASTA_RELEASES, { recursive: true });
  execFileSync("tar", ["-czf", SAIDA_VERSIONADA, "Dockerfile", "packages", "plugins"], {
    cwd: temp,
    stdio: "inherit"
  });
  fs.copyFileSync(SAIDA_VERSIONADA, SAIDA);

  const mb = (fs.statSync(SAIDA).size / 1024 / 1024).toFixed(2);
  console.log(`\nPacote gerado (v${version}): ${SAIDA_VERSIONADA} (${mb} MB)`);
  console.log(`Cópia da versão atual em: ${SAIDA}`);
  console.log("No Portainer, em Images > Build a new image > Upload, enviar o arquivo.");
  console.log("Não precisa informar caminho do Dockerfile — ele já está na raiz do pacote.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
