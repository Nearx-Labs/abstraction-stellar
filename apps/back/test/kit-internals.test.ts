// Guarda do import de caminho privado do smart-account-kit.
//
// O back constrói o AuthPayload da conta mestre com helpers que o kit não
// reexporta na raiz. É uma dependência frágil de propósito assumida — o custo
// de manter uma segunda cópia do encoding seria pior — e o preço é este teste:
// um upgrade do kit que mova o arquivo ou renomeie um export quebra AQUI, no
// CI, em vez de quebrar em produção quando o contrato recusar a transação.
import { describe, expect, it } from 'vitest';
import { Keypair, xdr } from '@stellar/stellar-sdk';

const { authPayload, REQUIRED_EXPORTS } = await import('../src/chain/kitInternals.js');
const { masterSignerFor, masterSignerIdentity } = await import('../src/chain/masterSigner.js');

describe('helpers internos do kit', () => {
  it('expõe tudo que o back usa', () => {
    for (const name of REQUIRED_EXPORTS) {
      expect(authPayload[name], `export ausente: ${name}`).toBeTypeOf('function');
    }
  });

  it('signerToScVal produz o encoding External que o contrato espera', () => {
    const keypair = Keypair.random();
    const verifier = 'CCNJDEL774D5UIOEYXIJZRY3HVVR4FIKGGURY34TFCWPAC25QYNRUKMJ';

    const scv = authPayload.signerToScVal({
      tag: 'External',
      values: [verifier, keypair.rawPublicKey()],
    });

    // Signer::External(verifier, key_data) vira scvVec[Symbol, Address, Bytes].
    expect(scv.switch().name).toBe('scvVec');
    const items = scv.vec() ?? [];
    expect(items[0]!.sym().toString()).toBe('External');
    expect(items[1]!.switch().name).toBe('scvAddress');
    expect(Buffer.from(items[2]!.bytes())).toEqual(keypair.rawPublicKey());
  });

  it('o AuthPayload que montamos volta a ser lido pelo próprio kit', () => {
    const keypair = Keypair.random();
    const verifier = 'CCNJDEL774D5UIOEYXIJZRY3HVVR4FIKGGURY34TFCWPAC25QYNRUKMJ';
    const signature = keypair.sign(Buffer.alloc(32, 7));
    const contextRuleId = 3;

    const signerKey = authPayload.signerToScVal({
      tag: 'External',
      values: [verifier, keypair.rawPublicKey()],
    });

    const payload = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('context_rule_ids'),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(contextRuleId)]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('signers'),
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: signerKey, val: xdr.ScVal.scvBytes(signature) }),
        ]),
      }),
    ]);

    // Round-trip pelo leitor do kit: se a ordem das chaves ou a forma do signer
    // estivessem erradas, isto falharia — e é exatamente o que o host valida.
    const parsed = authPayload.readAuthPayload(payload);
    expect(parsed.context_rule_ids).toEqual([contextRuleId]);
    expect(parsed.signers.size).toBe(1);
    expect([...parsed.signers.values()][0]).toEqual(signature);
  });
});

describe('chave da conta mestre', () => {
  it('é determinística por app', () => {
    const a = masterSignerFor('11111111-1111-4111-8111-111111111111');
    const b = masterSignerFor('11111111-1111-4111-8111-111111111111');
    expect(a.publicKey()).toBe(b.publicKey());
  });

  it('é diferente entre apps — um tenant não assina pelo outro', () => {
    const a = masterSignerFor('11111111-1111-4111-8111-111111111111');
    const b = masterSignerFor('22222222-2222-4222-8222-222222222222');
    expect(a.publicKey()).not.toBe(b.publicKey());
  });

  it('publica a identidade no formato do signer External', () => {
    const identity = masterSignerIdentity('11111111-1111-4111-8111-111111111111');
    expect(identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.verifier).toMatch(/^C[A-Z2-7]{55}$/);
  });
});
