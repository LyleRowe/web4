const {
    connect,
    keyStores: { InMemoryKeyStore },
    transactions: { Transaction, functionCall },
    KeyPair,
} = require('near-api-js');
const { PublicKey } = require('near-api-js/lib/utils');
const { signInURL, signTransactionsURL } = require('./util/web-wallet-api');

const fetch = require('node-fetch');
const qs = require('querystring');

const MAX_PRELOAD_HOPS = 5;
const IPFS_GATEWAY_URL = process.env.IPFS_GATEWAY_URL || 'https://ipfs.web4.near.page';

const config = require('./config')(process.env.NODE_ENV || 'development')

async function withNear(ctx, next) {
    // TODO: Why no default keyStore?
    const keyStore = new InMemoryKeyStore();
    const near = await connect({...config, keyStore});

    Object.assign(ctx, { config, keyStore, near });

    try {
        await next();
    } catch (e) {
        switch (e.type) {
            case 'AccountDoesNotExist':
                ctx.throw(404, e.message);
            case 'UntypedError':
            default:
                ctx.throw(400, e.message);
        }
    }
}

async function withAccountId(ctx, next) {
    const accountId = ctx.cookies.get('web4_account_id');
    ctx.accountId = accountId;
    await next();
}

async function requireAccountId(ctx, next) {
    if (!ctx.accountId) {
        ctx.redirect('/web4/login');
        return;
    }
    await next();
}

const Koa = require('koa');
const app = new Koa();

const Router = require('koa-router');
const router = new Router();

const koaBody = require('koa-body')();

const FAST_NEAR_URL = process.env.FAST_NEAR_URL;

const callViewFunction = async ({ near }, contractId, methodName, methodParams) => {
    if (FAST_NEAR_URL) {
        const res = await fetch(`${FAST_NEAR_URL}/account/${contractId}/view/${methodName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(methodParams)
        });
        if (!res.ok) {
            throw new Error(await res.text());
        }
        return await res.json();
    }

    const account = await near.account(contractId);
    return await account.viewFunction(contractId, methodName, methodParams);
}

router.get('/web4/contract/:contractId/:methodName', withNear, async ctx => {
    const {
        params: { contractId, methodName },
        query
    } = ctx;

    const methodParams = Object.keys(query)
        .map(key => key.endsWith('.json')
            ? { [key.replace(/\.json$/, '')]: JSON.parse(query[key]) }
            : { [key] : query[key] })
        .reduce((a, b) => ({...a, ...b}), {});

    ctx.body = await callViewFunction(ctx, contractId, methodName, methodParams);
});

router.get('/web4/login', withNear, withContractId, async ctx => {
    let {
        contractId,
        query: { callback_url }
    } = ctx;

    const appPrivateKey = ctx.cookies.get('web4_private_key');
    let keyPair
    if (appPrivateKey) {
        keyPair = KeyPair.fromString(appPrivateKey);
    } else {
        keyPair = KeyPair.fromRandom('ed25519');
        ctx.cookies.set('web4_private_key', keyPair.toString());
    }

    const loginCompleteUrl = `${ctx.origin}/web4/login/complete?${qs.stringify({ callback_url })}`;
    ctx.redirect(signInURL({
        walletUrl: config.walletUrl,
        contractId,
        publicKey: keyPair.getPublicKey().toString(),
        successUrl: loginCompleteUrl,
        failureUrl: loginCompleteUrl
    }));
});

router.get('/web4/login/complete', async ctx => {
    const { account_id, callback_url } = ctx.query;
    if (account_id) {
        ctx.cookies.set('web4_account_id', account_id);
        ctx.body = `Logged in as ${account_id}`;
    } else {
        ctx.body = `Couldn't login`;
    }

    // TODO: Require callback URL? Is referrer useful?
    if (callback_url) {
        ctx.redirect(callback_url);
    }
});

router.get('/web4/logout', async ctx => {
    let {
        query: { callback_url }
    } = ctx;
    // TODO: Validate callback_url / have default?

    ctx.cookies.set('web4_account_id');
    // TODO: Remove private key cookie (ideally also somehow remove key from account?)

    ctx.redirect(callback_url);
});

const DEFAULT_GAS = '300' + '000000000000';

router.post('/web4/contract/:contractId/:methodName', koaBody, withNear, withAccountId, requireAccountId, async ctx => {
    // TODO: Accept both json and form submission

    const accountId = ctx.accountId;

    const appPrivateKey = ctx.cookies.get('web4_private_key');

    const { contractId, methodName } = ctx.params;
    const { body } = ctx.request;
    const { web4_gas: gas, web4_deposit: deposit, web4_callback_url } = body;
    const args = Object.keys(body)
        .filter(key => !key.startsWith('web4_'))
        .map(key => ({ [key]: body[key] }))
        .reduce((a, b) => ({...a, ...b}), {});

    const callbackUrl = new URL(web4_callback_url || '/', ctx.origin).toString()

    // Check if can be signed without wallet
    if (appPrivateKey && accountId == contractId && !deposit || deposit == '0') {
        const keyPair = KeyPair.fromString(appPrivateKey);
        const appKeyStore = new InMemoryKeyStore();
        await appKeyStore.setKey(ctx.near.connection.networkId, accountId, keyPair);

        const near = await connect({ ...ctx.near.config, keyStore: appKeyStore });
        const account = await near.account(accountId);
        // TODO: Test this

        await account.functionCall({ contractId, methodName, args, gas: gas || DEFAULT_GAS, deposit: deposit || '0' });
        ctx.redirect(callbackUrl);
        // TODO: Pass transaction hashes, etc to callback?
        return;
    }

    // NOTE: publicKey, nonce, blockHash keys are faked as reconstructed by wallet
    const transaction = new Transaction({
        signerId: accountId,
        publicKey: new PublicKey({ type: 0, data: Buffer.from(new Array(32))}),
        nonce: 0,
        receiverId: contractId,
        actions: [
            functionCall(methodName, args, gas || DEFAULT_GAS, deposit || '0')
        ],
        blockHash: Buffer.from(new Array(32))
    });
    const url = signTransactionsURL({
        walletUrl: config.walletUrl,
        transactions: [transaction],
        callbackUrl
    });
    ctx.redirect(url);
    // TODO: Need to do something else than wallet redirect for CORS-enabled fetch
});

async function withContractId(ctx, next) {
    let contractId = process.env.CONTRACT_NAME;
    if (ctx.host.endsWith('.near.page')) {
        contractId = ctx.host.replace(/.page$/, '');
    }
    if (ctx.host.endsWith('.testnet.page')) {
        contractId = ctx.host.replace(/.page$/, '');
    }
    ctx.contractId = contractId;

    return await next();
}

// TODO: Do contract method call according to mapping returned by web4_routes contract method
// TODO: Use web4_get method in smart contract as catch all if no mapping?
// TODO: Or is mapping enough?
router.get('/(.*)', withNear, withContractId, withAccountId, async ctx => {
    const {
        accountId,
        path,
        query
    } = ctx;
    let { contractId } = ctx;

    const methodParams = {
        request: {
            accountId,
            path,
            query: Object.keys(query)
                .map(key => ({ [key] : Array.isArray(query[key]) ? query[key] : [query[key]] }))
                .reduce((a, b) => ({...a, ...b}), {})
        }
    };

    for (let i = 0; i < MAX_PRELOAD_HOPS; i++) {
        let res;
        try {
            res = await callViewFunction(ctx, contractId, 'web4_get', methodParams);
        } catch (e) {
            // Support hosting web4 contract on subaccount like web4.vlad.near
            // TODO: Cache whether given account needs this
            // TODO: remove nearcore error check after full migration to fast-near
            if (e.message.includes('FunctionCallError(CompilationError(CodeDoesNotExist')
                || e.message.includes('FunctionCallError(MethodResolveError(MethodNotFound))')
                || e.message.startsWith('codeNotFound')
                || e.message.includes('method web4_get not found')) {

                if (i == 0) {
                    contractId = `web4.${contractId}`;
                    continue;
                }
            }

            if (e.toString().includes('block height')) {
                console.error('error', e);
            }
            throw e;
        }

        const { contentType, status, body, bodyUrl, preloadUrls } = res;

        if (status) {
            ctx.status = status;
            if (!body && !bodyUrl) {
                ctx.body = ctx.message;
                return;
            }
        }

        if (body) {
            ctx.type = contentType;
            ctx.body = Buffer.from(body, 'base64');
            return;
        }

        if (bodyUrl) {
            let absoluteUrl = new URL(bodyUrl, ctx.origin).toString();
            if (absoluteUrl.startsWith('ipfs:')) {
                const { hostname, pathname, search } = new URL(absoluteUrl);
                absoluteUrl = `${IPFS_GATEWAY_URL}/ipfs/${hostname}${pathname}${search}`;
            }

            console.info('Loading', absoluteUrl);
            const res = await fetch(absoluteUrl);
            if (!status) {
                ctx.status = res.status;
            }


            const needToUncompress = !!res.headers.get('content-encoding');
            for (let [key, value] of res.headers.entries()) {
                if (needToUncompress && ['content-encoding', 'content-length'].includes(key)) {
                    // NOTE: fetch returns Gunzip stream, so response doesn't get compressed + content length is off
                    // TODO: Figure out how to relay compressed stream instead
                    continue;
                }
                ctx.set(key, value);
            }
            if (contentType) {
                ctx.type = contentType;
            }
            ctx.body = res.body;
            return;
        }

        if (preloadUrls) {
            const preloads = await Promise.all(preloadUrls.map(async url => {
                const absoluteUrl = new URL(url, ctx.origin).toString();
                const res = await fetch(absoluteUrl);
                return [url, {
                    contentType: res.headers.get('content-type'),
                    body: (await res.buffer()).toString('base64')
                }];
            }));
            methodParams.request.preloads = preloads.map(([key, value]) => ({[key] : value}))
                .reduce((a, b) => ({...a, ...b}), {});
            continue;
        }

        break;
    }

    ctx.throw(502, 'too many preloads');
});

// TODO: submit transaction mapping path to method name
router.post('/(.*)', ctx => {
    ctx.body = ctx.path;
});


// TODO: Need to query smart contract for rewrites config

app
    .use(async (ctx, next) => {
        console.log(ctx.method, ctx.host, ctx.path);
        await next();
    })
    .use(router.routes())
    .use(router.allowedMethods());

module.exports = app;

