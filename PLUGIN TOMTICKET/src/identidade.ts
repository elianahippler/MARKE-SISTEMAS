/**
 * Identidade do plugin, num lugar só.
 *
 * O `id` é a CHAVE do plugin instalado: aparece na rota que o frontend monta,
 * nas chaves do storage e no cadastro do plugin na empresa. Renomear exige
 * reinstalar nas empresas que já o tinham, senão a instalação antiga fica
 * órfã apontando para um id que não existe mais.
 */

/** Id técnico — usado em rotas, storage e no registro da instalação. */
export const PLUGIN_ID = "tomticket";

/** Nome que aparece na tela para quem usa. */
export const PLUGIN_NOME = "TomTicket";

/** Prefixo dos logs deste plugin. */
export const LOG = `[${PLUGIN_NOME}]`;
