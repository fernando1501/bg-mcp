import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    assertReadOnly,
    isReadOnly,
    ReadOnlyViolationError,
    READ_ONLY_ENDPOINTS,
} from '../src/http/guard.js';

test('allows the read endpoints the tools actually use', () => {
    const allowed: Array<[string, string]> = [
        ['GET', '/o/api/dashboard/product'],
        ['GET', '/o/api/dashboard/tour'],
        ['GET', '/o/api/product-info/saving-account/state/1'],
        ['GET', '/o/api/product-info/saving-account/movement/12'],
        ['POST', '/o/api/product-info/saving-account/find'],
        ['POST', '/o/api/product-info/credit-card/find'],
        ['POST', '/o/api/product-info/credit-card/state'],
        ['POST', '/o/api/product-info/credit-card/state-card'],
        ['GET', '/o/api/product-info/credit-card/credit-card-statement-history/4'],
        ['POST', '/o/api/product-info/credit-card/credit-card-categories-totals'],
        ['GET', '/o/api/product-info/profuture/state/5'],
        ['POST', '/o/api/product-info/profuture/statement/'],
    ];
    for (const [method, path] of allowed) {
        assert.ok(isReadOnly(method, path), `expected ${method} ${path} to be allowed`);
    }
});

test('blocks the Liferay RPC gateway', () => {
    // /api/jsonws/invoke can reach any portlet service, including transfers.
    assert.throws(() => assertReadOnly('POST', '/api/jsonws/invoke'), ReadOnlyViolationError);
    assert.throws(() => assertReadOnly('GET', '/api/jsonws/invoke'), ReadOnlyViolationError);
});

test('blocks money-movement routes', () => {
    const blocked = [
        '/o/api/product-info/credit-card/pay-card/pay',
        '/o/api/product-info/credit-card/pay-card/origin-accounts',
        '/o/api/transfer/cuentas-propias',
        '/o/api/transfer/terceros',
        '/o/api/transfer/internacionales',
        '/o/api/pagos/execute',
        '/o/api/product-info/credit-card/pagar-tarjeta',
        '/o/api/product-info/saving-account/editar-cuenta',
        '/o/api/product-info/saving-account/toggle-account',
        '/o/api/effective-communication/watch-later',
        '/o/api/product-info/credit-card/solicitar-pin',
        '/o/api/product-info/credit-card/reportar-tarjeta-perdida',
    ];
    for (const path of blocked) {
        assert.throws(
            () => assertReadOnly('POST', path),
            ReadOnlyViolationError,
            `expected POST ${path} to be blocked`,
        );
        assert.throws(
            () => assertReadOnly('GET', path),
            ReadOnlyViolationError,
            `expected GET ${path} to be blocked`,
        );
    }
});

test('rejects an allowed route requested with the wrong method', () => {
    assert.throws(
        () => assertReadOnly('GET', '/o/api/product-info/saving-account/find'),
        /different HTTP method/,
    );
    assert.throws(
        () => assertReadOnly('POST', '/o/api/dashboard/product'),
        /different HTTP method/,
    );
});

test('rejects verbs that are never read operations', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        assert.throws(
            () => assertReadOnly(method, '/o/api/dashboard/product'),
            ReadOnlyViolationError,
            `expected ${method} to be rejected`,
        );
    }
});

test('rejects unknown routes and path-traversal attempts', () => {
    assert.throws(() => assertReadOnly('GET', '/o/api/does-not-exist'), ReadOnlyViolationError);
    assert.throws(() => assertReadOnly('GET', '/'), ReadOnlyViolationError);
    assert.throws(() => assertReadOnly('GET', ''), ReadOnlyViolationError);
    // A suffix must not sneak past an anchored pattern.
    assert.throws(
        () => assertReadOnly('GET', '/o/api/dashboard/product/../../transfer'),
        ReadOnlyViolationError,
    );
    assert.throws(() => assertReadOnly('GET', '/o/api/dashboard/productX'), ReadOnlyViolationError);
});

test('rejects absolute URLs so the axios baseURL cannot be bypassed', () => {
    assert.throws(
        () => assertReadOnly('GET', 'https://evil.example.com/o/api/dashboard/product'),
        /absolute URLs are not allowed/,
    );
    assert.throws(
        () => assertReadOnly('GET', 'https://zonasegura.bgeneral.com/o/api/dashboard/product'),
        /absolute URLs are not allowed/,
    );
});

test('ignores the query string when matching', () => {
    assert.ok(isReadOnly('GET', '/o/api/dashboard/product?uutime=1779460259.872'));
    // ...but a blocked fragment in the path is still caught.
    assert.throws(() => assertReadOnly('GET', '/o/api/transfer/terceros?x=1'), ReadOnlyViolationError);
});

test('every allowlist entry is anchored at both ends', () => {
    // An unanchored pattern would let a suffix like `/pay` ride along.
    for (const endpoint of READ_ONLY_ENDPOINTS) {
        const src = endpoint.pattern.source;
        assert.ok(src.startsWith('^'), `${endpoint.name} pattern is not start-anchored`);
        assert.ok(src.endsWith('$'), `${endpoint.name} pattern is not end-anchored`);
    }
});
