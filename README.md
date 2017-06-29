# mongoose-transaction-plugin
A mongoose plugin for transaction-like semantics between multiple documents.

[![Build Status](https://api.travis-ci.org/spearhead-ea/mongoose-transaction-plugin.svg?branch=master)](https://travis-ci.org/spearhead-ea/mongoose-transaction-plugin?branch=master)
[![NPM version](https://badge.fury.io/js/mongoose-transaction-plugin.svg)](http://badge.fury.io/js/mongoose-transaction-plugin)
[![Dependency Status](https://david-dm.org/spearhead-ea/mongoose-transaction-plugin/status.svg)](https://david-dm.org/spearhead-ea/mongoose-transaction-plugin)
[![Coverage Status](https://coveralls.io/repos/github/spearhead-ea/mongoose-transaction-plugin/badge.svg?branch=master)](https://coveralls.io/github/spearhead-ea/mongoose-transaction-plugin?branch=master)

## Tests

  To run the test suite, first install the dependencies, then run `npm test`:

```bash
$ npm install
$ npm test
```

## Example

```typescript
import { plugin, Transaction } from 'mongoose-transaction-plugin';

(async function () {
  await new Promise(cb => mongoose.connect(process.env.MONGODB, cb));
  
  const testPlayerSchema = new mongoose.schema({ name: String });
  testPlayerSchema.plugin(plugin);
  const TestPlayer = conn.model('TestPlayer', testPlayerSchema);
  
  const testDataSchema = new mongoose.schema({ money: Number });
  testDataSchema.plugin(plugin);
  const TestData = conn.model('TestData', testDataSchema);
  
  Transaction.initialize(conn);
  
  await Transaction.scope(async t => {
    const p = await t.findOne(TestPlayer, { name: 'wokim' });
    const d = await t.findOne(TestData, { money: { '$eq': 500 }});
    p.name = 'wokim2';
    d.money += 600;
  });
})();

```
# Environment Variables

| Environment                  | Type                  | Notes
| ---------------------------- | --------------------- | -----
| `TRANSACTION_KEEP_COMMITTED` | true / false          | (false) 커밋된 트랜젝션 오브젝트를 보관할지 여부