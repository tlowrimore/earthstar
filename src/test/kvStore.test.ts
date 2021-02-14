import fs from 'fs';
import t = require('tap');
import {
    IKvStore,
    KvStoreJsonFile,
    KvStoreMemory
} from '../peer/kvstore';
import { sorted } from '../util/helpers';
//t.runOnly = true;

//================================================================================

let scenarios = [
    {
        description: 'memory',
        makeKvStore: (): IKvStore => {
            return new KvStoreMemory();
        },
        cleanup: () => {},
    },
    {
        description: 'json',
        makeKvStore: (): IKvStore => {
            return new KvStoreJsonFile('temp12345.json');
        },
        cleanup: () => {
            fs.unlinkSync('temp12345.json');
        },
    }
]

//================================================================================

for (let scenario of scenarios) {

    t.test(scenario.description + ': basic kvStore tests', async (t: any) => {
        let store = scenario.makeKvStore();

        t.deepEqual(await store.listKeys(), [], 'listKeys is empty');
        try {
            await store.deleteKey('foo');
            t.pass('deleting nonexistant key should not throw');
        } catch (err) {
            t.fail('deleting nonexistant key should not throw');
        }
        t.strictEqual(await store.get('foo'), undefined, '404? undefined');
        await store.set('foo', 'bar');
        t.strictEqual(await store.get('foo'), 'bar', 'set and get works');
        await store.set('foo', 'bar2');
        t.strictEqual(await store.get('foo'), 'bar2', 'set and get works twice');
        await store.deleteKey('foo');
        t.strictEqual(await store.get('foo'), undefined, 'deleteKey works');

        scenario.cleanup();
        t.done();
    });

    t.test(scenario.description + ': multi-key tests', async (t: any) => {
        let store = scenario.makeKvStore();

        let keys = 'a b t w d j z'.split(' ');
        let sortedKeys = sorted(keys);

        for (let key of keys) {
            await(store.set(key, 'ok'));
        }
        t.deepEqual(await store.listKeys(), sortedKeys, 'listKeys is sorted');
        await store.deleteAll();
        t.deepEqual(await store.listKeys(), [], 'deleteAll works');

        scenario.cleanup();
        t.done();
    });

    if (scenario.description !== 'memory') {
        // memory store will fail this test obviously

        t.test(scenario.description + ': load existing data', async (t: any) => {
            let store = scenario.makeKvStore();

            t.strictEqual(await store.get('hello'), undefined, 'data does not exist yet');
            await store.set('hello', 'world');

            let store2 = scenario.makeKvStore();

            t.strictEqual(await store2.get('hello'), 'world', 'data should be loaded on instantiation');

            scenario.cleanup();
            t.done();
        });
    }

}
