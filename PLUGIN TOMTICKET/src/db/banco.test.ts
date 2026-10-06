import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { abrirBanco, migrar, estatisticas, preparado, type Banco } from "@/db/banco";

/**
 * Os testes abrem o banco com `abrirBanco(":memory:")`.
 *
 * Em memória porque cada teste quer um banco limpo, e por `abrirBanco` — não
 * construindo o `DatabaseSync` à mão — por duas razões:
 *
 * - exercita o caminho real (pragmas, migração, carga do módulo nativo), em
 *   vez de um atalho que o plugin nunca percorre;
 * - o `node:sqlite` só é carregado DENTRO de `banco.ts`, por `createRequire`.
 *   Um `import { DatabaseSync } from "node:sqlite"` aqui faria o Vite tentar
 *   resolver o módulo e falhar — ele não reconhece esse builtin (ver o
 *   comentário de `carregarSqlite`).
 *
 * `:memory:` não suporta WAL (o `journal_mode` fica "memory"), e isso não é
 * problema: o pragma não lança, e o que ele protege — arquivo em disco — não
 * existe aqui.
 */

let banco: Banco;

beforeEach(() => {
  banco = abrirBanco(":memory:");
});
afterEach(() => banco.close());

describe("abrirBanco", () => {
  it("cria as tabelas do plugin", () => {
    const tabelas = banco
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tabelas).toContain("vinculos");
    expect(tabelas).toContain("transcricoes");
    expect(tabelas).toContain("eventos");
    expect(tabelas).toContain("marcos");
  });

  it("liga as chaves estrangeiras — sem isso o cascade não acontece", () => {
    // `foreign_keys` é OFF por padrão no SQLite. Sem o pragma, apagar um
    // vínculo deixaria as transcrições dele órfãs na tabela.
    expect(Number(banco.prepare("PRAGMA foreign_keys").get()?.foreign_keys)).toBe(1);
  });

  it("apaga as transcrições junto com o vínculo", () => {
    banco
      .prepare(
        `INSERT INTO vinculos (ticket_id, chamado_id, cliente_email, criado_em, atualizado_em)
         VALUES ('1', 'ch1', 'a@b.c', 'x', 'x')`
      )
      .run();
    banco.prepare("INSERT INTO transcricoes (ticket_id, wid, quando) VALUES ('1', 'w1', 'x')").run();

    banco.prepare("DELETE FROM vinculos WHERE ticket_id = '1'").run();
    expect(Number(banco.prepare("SELECT COUNT(*) AS n FROM transcricoes").get().n)).toBe(0);
  });
});

describe("migrar", () => {
  it("marca a versão no user_version do arquivo", () => {
    const versao = Number(banco.prepare("PRAGMA user_version").get()?.user_version);
    expect(versao).toBeGreaterThan(0);
  });

  it("é idempotente — rodar de novo não refaz nada", () => {
    // É o caso de TODO boot: `abrirBanco` chama `migrar` sempre. Sem o
    // controle por `user_version`, o segundo CREATE TABLE falharia com
    // "table already exists" e o plugin não subiria na segunda vez.
    const primeira = Number(banco.prepare("PRAGMA user_version").get()?.user_version);
    expect(() => migrar(banco)).not.toThrow();
    expect(migrar(banco)).toBe(primeira);
  });
});

describe("estatisticas", () => {
  it("conta vínculos e separa os abertos dos finalizados", () => {
    const inserir = banco.prepare(
      `INSERT INTO vinculos (ticket_id, chamado_id, cliente_email, finalizado, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    inserir.run("1", "ch1", "a@b.c", 0, "2026-10-06", "2026-10-06");
    inserir.run("2", "ch2", "a@b.c", 1, "2026-10-06", "2026-10-06");

    const stats = estatisticas(banco);
    expect(stats.vinculos).toBe(2);
    expect(stats.abertos).toBe(1);
  });

  it("informa o tamanho do arquivo e a versão do schema", () => {
    const stats = estatisticas(banco);
    expect(stats.versaoSchema).toBeGreaterThan(0);
    expect(stats.tamanhoBytes).toBeGreaterThan(0);
  });
});

describe("o caminho reportado", () => {
  it("é o que foi realmente aberto, não o padrão", () => {
    // A aba Diagnóstico mostra este caminho. Reportar o padrão quando o banco
    // foi aberto em outro lugar mandaria quem depura procurar o arquivo errado
    // — e no modo multi-tenant apontaria todas as empresas para o mesmo.
    expect(estatisticas(banco).caminho).toBe(":memory:");
  });
});

describe("preparado (cache de statements)", () => {
  it("devolve o MESMO statement para o mesmo SQL", () => {
    // É o ponto do cache: compilar o SQL custava 61% do tempo de uma leitura,
    // e essa leitura acontece em toda mensagem de todo atendimento.
    const sql = "SELECT * FROM vinculos WHERE ticket_id = ?";
    expect(preparado(banco, sql)).toBe(preparado(banco, sql));
  });

  it("statements diferentes para SQL diferente", () => {
    expect(preparado(banco, "SELECT 1 AS a")).not.toBe(preparado(banco, "SELECT 2 AS a"));
  });

  it("o statement reaproveitado continua respondendo certo", () => {
    // Reusar um statement entre chamadas só é seguro se ele resetar sozinho;
    // se não resetasse, a segunda chamada viria vazia.
    banco.prepare("INSERT INTO vinculos (ticket_id, chamado_id, cliente_email, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)")
      .run("1", "c1", "a@b.c", "2026-01-01", "2026-01-01");
    const sql = "SELECT chamado_id FROM vinculos WHERE ticket_id = ?";
    expect(preparado(banco, sql).get("1").chamado_id).toBe("c1");
    expect(preparado(banco, sql).get("1").chamado_id).toBe("c1");
    expect(preparado(banco, sql).get("999")).toBeUndefined();
  });

  it("o cache de um banco não vaza para outro", () => {
    const outro = abrirBanco(":memory:");
    try {
      expect(preparado(banco, "SELECT 1 AS a")).not.toBe(preparado(outro, "SELECT 1 AS a"));
    } finally {
      outro.close();
    }
  });
});

describe("índices (migração 3)", () => {
  const plano = (sql: string, ...params: unknown[]): string =>
    banco.prepare("EXPLAIN QUERY PLAN " + sql).all(...params).map((l: any) => l.detail).join(" | ");

  it("a busca por protocolo OU hash usa índice nos dois lados", () => {
    // Com índice só no protocolo, o OR não permitia união de índices e o
    // SQLite varria a tabela inteira (SCAN vinculos) — 834 µs contra 39 µs.
    const detalhe = plano(
      "SELECT * FROM vinculos WHERE (protocolo = ? OR chamado_id = ?) ORDER BY criado_em DESC LIMIT 50",
      "x", "x"
    );
    expect(detalhe).toContain("idx_vinculos_protocolo");
    expect(detalhe).toContain("idx_vinculos_chamado");
    expect(detalhe).not.toContain("SCAN vinculos (");
  });

  it("a listagem de abertos usa o índice parcial", () => {
    expect(plano("SELECT * FROM vinculos WHERE finalizado = 0 ORDER BY criado_em DESC LIMIT 50"))
      .toContain("idx_vinculos_abertos");
  });

  it("a contagem de linhas de chamado não varre a tabela de eventos", () => {
    expect(plano("SELECT COUNT(*) FROM eventos WHERE eh_chamado = 1")).toContain("idx_eventos_chamado");
  });
});
