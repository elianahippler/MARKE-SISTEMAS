import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { abrirBanco, type Banco } from "@/db/banco";
import { RepositorioVinculos } from "@/db/vinculos";
import { RepositorioEventos } from "@/db/eventos";
import { importarDoStorage, jaImportado } from "@/db/importar";

/**
 * Estes testes guardam a parte mais arriscada da mudança.
 *
 * A 0.1.11 está em produção com atendimentos EM CURSO, e o vínculo
 * ticket↔chamado deles vive no PluginStorage. Uma importação que erre
 * silenciosamente não quebra o deploy — ela faz cada atendimento aberto abrir
 * um SEGUNDO chamado no TomTicket na próxima mensagem, e o cliente termina com
 * dois protocolos para o mesmo assunto. O estrago aparece horas depois, no
 * atendimento, não no log do boot.
 */

let banco: Banco;

beforeEach(() => {
  banco = abrirBanco(":memory:");
});
afterEach(() => banco.close());

/** Um `server.client` falso, só com o `storage` que a importação usa. */
function servidorFake(chaves: Array<{ key: string; value: any }>, diagnostico: any = null) {
  return {
    client: {
      storage: {
        async list(prefixo?: string) {
          return chaves
            .filter(c => !prefixo || c.key.startsWith(prefixo))
            .map(c => ({ ...c, expiresAt: null }));
        },
        async get(chave: string) {
          if (chave === "diagnostico") return diagnostico;
          return null;
        }
      }
    }
  } as any;
}

const VINCULO_ANTIGO = {
  chamadoId: "bd86efff6ef2bf3da0433c4ef1940f69",
  protocolo: "74128",
  departamentoId: "dep-1",
  operadorAtual: "op-1",
  clienteEmail: "cliente@exemplo.com",
  filaId: "7",
  transcritos: ["wid-a", "wid-b"]
};

describe("importarDoStorage", () => {
  it("traz o vínculo com todos os campos", async () => {
    const server = servidorFake([{ key: "ticket:101", value: VINCULO_ANTIGO }]);

    const r = await importarDoStorage(server, banco);
    expect(r.pulada).toBe(false);
    expect(r.vinculos).toBe(1);

    const lido = new RepositorioVinculos(banco).ler("101")!;
    expect(lido.chamadoId).toBe(VINCULO_ANTIGO.chamadoId);
    expect(lido.protocolo).toBe("74128");
    expect(lido.departamentoId).toBe("dep-1");
    expect(lido.operadorAtual).toBe("op-1");
    expect(lido.clienteEmail).toBe("cliente@exemplo.com");
    expect(lido.filaId).toBe("7");
  });

  it("tira o id do ticket da chave, sem o prefixo", async () => {
    // `storage.list` devolve "ticket:101"; gravar isso como id deixaria o
    // vínculo inalcançável — o fluxo procura por "101".
    const server = servidorFake([{ key: "ticket:101", value: VINCULO_ANTIGO }]);
    await importarDoStorage(server, banco);
    expect(new RepositorioVinculos(banco).ler("101")).not.toBeNull();
    expect(new RepositorioVinculos(banco).ler("ticket:101")).toBeNull();
  });

  it("move os transcritos do array para a tabela", async () => {
    const server = servidorFake([{ key: "ticket:101", value: VINCULO_ANTIGO }]);
    const r = await importarDoStorage(server, banco);

    expect(r.transcricoes).toBe(2);
    const repo = new RepositorioVinculos(banco);
    expect(repo.jaTranscrito("101", "wid-a")).toBe(true);
    expect(repo.jaTranscrito("101", "wid-b")).toBe(true);
  });

  it("preserva o estado de finalizado", async () => {
    // Importar um chamado finalizado como aberto o faria receber resposta de
    // novo — e responder num chamado finalizado o REABRE no TomTicket.
    const server = servidorFake([
      { key: "ticket:9", value: { ...VINCULO_ANTIGO, finalizado: true, finalizadoPor: "transferencia" } }
    ]);
    await importarDoStorage(server, banco);

    const lido = new RepositorioVinculos(banco).ler("9")!;
    expect(lido.finalizado).toBe(true);
    expect(lido.finalizadoPor).toBe("transferencia");
  });

  it("ignora chave sem chamadoId — sobra de gravação parcial", async () => {
    // Importar isso criaria uma linha que o fluxo leria como "já tem chamado",
    // e o atendimento nunca abriria o dele.
    const server = servidorFake([
      { key: "ticket:1", value: { clienteEmail: "a@b.c" } },
      { key: "ticket:2", value: null },
      { key: "ticket:3", value: VINCULO_ANTIGO }
    ]);

    const r = await importarDoStorage(server, banco);
    expect(r.vinculos).toBe(1);
    expect(new RepositorioVinculos(banco).ler("3")).not.toBeNull();
    expect(new RepositorioVinculos(banco).ler("1")).toBeNull();
  });

  it("traz o diagnóstico antigo", async () => {
    const server = servidorFake([], [
      { quando: "2026-10-01T10:00:00.000Z", nivel: "erro", texto: "token inválido" },
      { quando: "2026-10-01T10:01:00.000Z", nivel: "info", texto: "ticket 1 → chamado 9" }
    ]);

    const r = await importarDoStorage(server, banco);
    expect(r.eventos).toBe(2);
    expect(new RepositorioEventos(banco).contagens().tudo).toBe(2);
  });

  it("descarta evento malformado em vez de gravar linha quebrada", async () => {
    const server = servidorFake([], [
      { quando: "2026-10-01T10:00:00.000Z", nivel: "erro", texto: "bom" },
      { nivel: "erro", texto: "sem quando" },
      { quando: "x", texto: "sem nivel" },
      null
    ]);

    const r = await importarDoStorage(server, banco);
    expect(r.eventos).toBe(1);
  });

  it("falha no diagnóstico não impede a vinda dos vínculos", async () => {
    // O diagnóstico é auxiliar; o vínculo é o que o atendimento precisa.
    const server = servidorFake([{ key: "ticket:101", value: VINCULO_ANTIGO }]);
    server.client.storage.get = async () => {
      throw new Error("storage fora do ar");
    };

    const r = await importarDoStorage(server, banco);
    expect(r.vinculos).toBe(1);
    expect(r.eventos).toBe(0);
  });
});

describe("o marco de 'já importei'", () => {
  it("não repete a importação no boot seguinte", async () => {
    const server = servidorFake([{ key: "ticket:101", value: VINCULO_ANTIGO }]);

    await importarDoStorage(server, banco);
    expect(jaImportado(banco)).toBe(true);

    const segunda = await importarDoStorage(server, banco);
    expect(segunda.pulada).toBe(true);
    expect(segunda.vinculos).toBe(0);
  });

  it("reimportar sem o marco não duplica nada", async () => {
    // Rede de segurança: se o marco se perder (restauração de backup, por
    // exemplo), a importação roda de novo — e o upsert tem de absorver isso.
    const server = servidorFake([{ key: "ticket:101", value: VINCULO_ANTIGO }]);
    await importarDoStorage(server, banco);

    banco.prepare("DELETE FROM marcos").run();
    await importarDoStorage(server, banco);

    expect(Number(banco.prepare("SELECT COUNT(*) AS n FROM vinculos").get().n)).toBe(1);
    expect(Number(banco.prepare("SELECT COUNT(*) AS n FROM transcricoes").get().n)).toBe(2);
  });

  it("sem client marca como feita — nada a trazer", async () => {
    // É o plugin rodando solto em desenvolvimento, nunca provisionado. Sem o
    // marco, a tentativa se repetiria em todo boot sem nunca ter o que fazer.
    const r = await importarDoStorage({ client: null } as any, banco);
    expect(r.pulada).toBe(false);
    expect(r.vinculos).toBe(0);
    expect(jaImportado(banco)).toBe(true);
  });

  it("storage fora do ar não grava o marco — tenta no próximo boot", async () => {
    const server = servidorFake([]);
    server.client.storage.list = async () => {
      throw new Error("backend fora do ar");
    };

    await expect(importarDoStorage(server, banco)).rejects.toThrow("backend fora do ar");
    // O marco NÃO pode estar gravado: senão os vínculos de produção nunca
    // viriam, e o plugin seguiria para sempre achando que já importou.
    expect(jaImportado(banco)).toBe(false);
  });
});
