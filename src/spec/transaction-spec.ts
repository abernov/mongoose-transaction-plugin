import 'source-map-support/register';
import * as mongoose from 'mongoose';
import * as Bluebird from 'bluebird';
import * as _debug from 'debug';
import * as _ from 'lodash';

import { plugin } from '../plugin';
import { Transaction } from '../transaction';
import { ObjectId } from '../utils';

const mockgoose = require('mockgoose');

export function spec(assertion: () => Promise<void>) {
  return function (done) {
    assertion.call(this).then(done, done.fail);
  };
}

async function expectToThrow(fn, expected?: any) {
  try {
    await fn();
    expect(false).toEqual(true);
  } catch (e) {
    expect(() => {
      throw e;
    }).toThrow();
  }
}

const debug = _debug('transaction:test');
const conn: mongoose.Connection = mongoose.connection;

describe('Transaction-static', () => {
  it('should not allow an unique index', spec(async () => {
    expect(() => {
      new mongoose.Schema({ name: String }).index('name', {unique: true}).plugin(plugin);
    }).toThrowError(`Transaction doesn't support an unique index (name) shardKey (null)`);

    expect(() => {
      new mongoose.Schema({ type: { type: Number, index: true, unique: true } }).plugin(plugin);
    }).toThrowError(`Transaction doesn't support an unique index (type) shardKey (null)`);

    expect(() => {
      new mongoose.Schema({ type: { type: Number, index: true } }).plugin(plugin);
    }).not.toThrowError(`Transaction doesn't support an unique index (type) shardKey (null)`);

    expect(() => {
      new mongoose.Schema({ name: String }).plugin(plugin).index('name', {unique: true});
    }).toThrowError(`Transaction doesn't support an unique index (name) shardKey (null)`);
  }));
});

xdescribe('Transaction-static(turned-off)', () => {
  it('should not allow an unique index to SchemaType', spec(async () => {
    // I have no idea how to override this.
    // @kson //2017-01-23
    expect(() => {
      new mongoose.Schema({ name: String }).plugin(plugin).path('name').index({unique: true});
    }).toThrowError(`Transaction doesn't support an unique index (name)`);
  }));
});

describe('Transaction', () => {
  interface ITestPlayer extends mongoose.Document {
    name: string;
    age: number;
    money: number;
  }

  let TestPlayer: mongoose.Model<ITestPlayer>;

  beforeAll(spec(async () => {
    await mockgoose(mongoose);
    await new Promise(resolve => mongoose.connect('test', resolve));

    const testPlayerSchema = new mongoose.Schema({ name: String, age: Number, money: Number });
    testPlayerSchema.plugin(plugin);
    TestPlayer = conn.model<ITestPlayer>('TestPlayer', testPlayerSchema);

    Transaction.initialize(conn);
  }));

  beforeEach(spec(async () => {
    const testPlayer1 = new TestPlayer({ name: 'ekim', age: 10, money: 0 });
    const testPlayer2 = new TestPlayer({ name: 'wokim', age: 50, money: 0 });
    await Transaction.scope(async (t) => {
      await t.insertDoc(testPlayer1);
      await t.insertDoc(testPlayer2);
    });
  }));

  it('should index state', spec(async () => {
    const indexes = Transaction.getModel.schema.indexes();
    const [fields, options] = indexes[0];
    expect(fields.state).toEqual(1);
    expect(options.background).toBeTruthy();
  }));

  it('should ignore calling begin() twice in silent', spec(async () => {
    await Transaction.scope(async (t) => {
      await t.begin();
      const d = await t.findOne(TestPlayer, {name: 'ekim'});
      expect(d.name).toEqual('ekim');
    });
  }));

  it('could use write lock', spec(async () => {
    const options = {
      transaction: true,
      __t: new mongoose.Types.ObjectId()
    };
    const doc = await TestPlayer.findOne({ name: 'ekim' }, {}, options).exec();
    expect(doc['__t']).toBeDefined();
    debug('__t is %s', doc['__t']);
    debug('save document to detach __t');

    const saved = await doc.save();
    expect(saved['__t']).toBeUndefined();
  }));

  it('should not allow `Model.findOne` with transaction out of a transaction disposer', spec(async () => {
    try {
      await TestPlayer.findOne({ name: 'ekim' }, {}, { transaction: true }).exec();
      expect(true).toEqual(false);
    } catch (e) {
      expect(() => {
        throw e;
      }).toThrow();
    }
  }));

  it('could commit two documents in same transaction', spec(async () => {
    await Transaction.scope(async (tx) => {
      const testPlayer = await tx.findOne(TestPlayer, { name: 'wokim' });
      debug('locking success: %o', testPlayer);
      testPlayer.money += 600;
    });
    expect(1).toBe(1);
  }));

  it('can not save without lock', spec(async () => {
    const doc = await TestPlayer.findOne({ name: 'ekim' }, {}).exec();
    expect(doc['__t']).toBeUndefined();
    try {
      await doc.save();
      expect(true).toEqual(false);
    } catch (e) {
      expect(true).toEqual(true);
    }
  }));

  it('duplicate findOne with One Transaction', spec(async () => {
    await Transaction.scope(async (t) => {
      const doc = await t.findOne(TestPlayer, { name: 'ekim' });
      expect(doc['__t']).toBeDefined();
      doc.money += 500;
      const secondTry = await t.findOne(TestPlayer, { name: 'ekim' });
      secondTry.money += 1000;
    });
    const doc = await TestPlayer.findOne({ name: 'ekim' }, {}).exec();
    expect(doc.money).toBe(1500);
  }));

  it('duplicate findOne with other conditions', spec(async () => {
    await Transaction.scope(async (t) => {
      const doc = await t.findOne(TestPlayer, { name: 'ekim' });
      expect(doc['__t']).toBeDefined();
      doc.money += 500;
      const sameButDiffConditionDoc = await t.findOne(TestPlayer, { age: 10 });
      sameButDiffConditionDoc.money += 1000;
    });
    const doc = await TestPlayer.findOne({ name: 'ekim' }, {}).exec();
    expect(doc.money).toBe(1500);
  }));

  it('should save new document without transaction', spec(async () => {
    const doc = new TestPlayer({ name: 'newbie', age: 1 });
    try {
      await doc.save();
      expect(true).toEqual(true);
    } catch (e) {
      expect(e).toBeUndefined();
    }
  }));

  it('should retry when it finds a live transaction', done => {
    function addMoney(name: string, money: number) {
      return Transaction.scope(t => {
        return t.findOne(TestPlayer, { name: name })
          .then(doc => {
            doc.money += money;
            return doc;
          });
      });
    }

    return Bluebird.all([
      addMoney('ekim', 100),
      addMoney('ekim', 100),
      addMoney('ekim', 100),
      addMoney('ekim', 100)
    ])
      .then((results) => {
        return Bluebird.resolve(TestPlayer.findOne({ name: 'ekim' }, {}).exec());
      })
      .then(doc => {
        expect(doc.money).toBe(400);
        done();
      });
  });

  it('should evaluate the condition on each retry', spec(async () => {
    async function grow() {
      let growth = false;
      await Transaction.scope(async t => {
        const wokim = await t.findOne(TestPlayer, { age: 50 });
        if (wokim) {
          growth = true;
          wokim.age++;
        }
      });
      return growth;
    }
    const result = _.countBy(await Bluebird.all([grow(), grow()]));
    expect(result['true']).toEqual(1);
    expect(result['false']).toEqual(1);
  }));

  it('delete all document', spec(async () => {
    async function removePlayerDoc(name: string) {
      await Transaction.scope(async (t) => {
        const doc = await t.findOne(TestPlayer, { name: name });
        await t.removeDoc(doc);
      });
    }
    try {
      await Bluebird.all([removePlayerDoc('ekim'), removePlayerDoc('wokim')]);
      expect(true).toEqual(true);
    } catch (e) {
      expect(true).toEqual(false);
    }
  }));

  it('should throw an error to resolve an expired transaction with no history', spec(async () => {
    const oldTransaction = new Transaction.getModel();
    oldTransaction._id = ObjectId.get(+new Date('2016-01-01'));
    await TestPlayer.collection.update({ name: 'ekim' }, { $set: { __t: oldTransaction._id } });

    await Transaction.scope(async (t) => {
      try {
        await t.findOne(TestPlayer, { name: 'ekim' });
        expect(true).toEqual(false);
      } catch (e) {
        expect(() => {
          throw e;
        }).toThrowError('There is no transaction history.');
      }
    });
  }));

  it('should cancel expired transaction which is stated as `init`', spec(async () => {
    const oldTransaction = new Transaction.getModel();
    oldTransaction._id = ObjectId.get(+new Date('2016-01-01'));
    oldTransaction.state = 'init';
    await oldTransaction.save();
    const savedOldTransaction = await Transaction.getModel.findOne({ _id: oldTransaction._id });
    expect(savedOldTransaction.state).toEqual('init');
    await TestPlayer.collection.update({ name: 'ekim' }, { $set: { __t: oldTransaction._id } });

    await Transaction.scope(async (t) => {
      await t.findOne(TestPlayer, { name: 'ekim' });
      const canceledOldTransaction = await Transaction.getModel.findOne({ _id: oldTransaction._id });
      expect(canceledOldTransaction.state).toEqual('canceled');
    });
  }));

  it('should recommit when it finds an old pending transaction', spec(async () => {
    const oldTransaction = new Transaction.getModel();
    oldTransaction._id = ObjectId.get(+new Date(new Date().getTime() - (1000 * 60 * 60)));
    oldTransaction.state = 'pending';

    const ekim = await TestPlayer.findOne({ name: 'ekim' });
    oldTransaction.history.push({
      col: TestPlayer.collection.name,
      oid: ekim._id,
      shardKeyName: 'name',
      shardKey: ekim.name,
      op: 'update',
      query: JSON.stringify({ $set: { money: 1000 } })
    });

    await oldTransaction.save();
    await TestPlayer.collection.update({ name: 'ekim' }, { $set: { __t: oldTransaction._id } });

    await Transaction.scope(async (t) => {
      const doc = await t.findOne(TestPlayer, { name: 'ekim' });

      expect(doc.money).toEqual(1000);

      const transaction = await Transaction.getModel.findOne({ _id: oldTransaction._id });
      if (transaction) {
        expect(transaction.state).toEqual('committed');
      } else {
        expect(await Transaction.getModel.count({_id: oldTransaction._id})).toEqual(0);
      }
    });
  }));

  it('should cancel transaction if the handler throws', spec(async () => {
    let tid;
    try {
      await Transaction.scope(async (t) => {
        tid = t._id;
        const doc = await t.findOne(TestPlayer, { name: 'ekim' });
        doc.money += 1000;
        throw new Error('hahaha');
      });
    } catch (e) {
      const transaction = await Transaction.getModel.findOne({ _id: tid });
      expect(transaction).toEqual(null);
      const ekim = await TestPlayer.findOne({ name: 'ekim' });
      expect(ekim.money).toEqual(0);
    }
  }));

  afterEach(spec(async () => {
    await new Promise((resolve) => mockgoose.reset(() => resolve()));
  }));

  afterAll(spec(async () => {
    await new Promise((resolve) => (mongoose as any).unmock(resolve));
    await new Promise(resolve => mongoose.disconnect(resolve));
  }));
});

describe('Transaction (_id uniqueness)', () => {
  interface ITestUniqIdx extends mongoose.Document {
    name: string;
  }

  let TestUniqId: mongoose.Model<ITestUniqIdx>;
  beforeAll(spec(async () => {
    await mockgoose(mongoose);
    await new Promise(resolve => mongoose.connect('test', resolve));

    const testUniqIdSchema = new mongoose.Schema({ name: String, type: String });
    testUniqIdSchema.plugin(plugin);
    TestUniqId = conn.model<ITestUniqIdx>('TestUniqIdx', testUniqIdSchema);

    Transaction.initialize(conn);
  }));

  afterEach(spec(async () => {
    await new Promise((resolve) => mockgoose.reset(() => resolve()));
  }));

  afterAll(spec(async () => {
    await new Promise((resolve) => (mongoose as any).unmock(resolve));
    await new Promise(resolve => mongoose.disconnect(resolve));
  }));

  it('SHOULD find _id conflict', spec(async () => {
    await expectToThrow(async () => {
      await Transaction.scope(async t => {
        const oid = new mongoose.Types.ObjectId();
        await t.insertDoc(new TestUniqId({ _id: oid }));
        await t.insertDoc(new TestUniqId({ _id: oid }));
      });
    });
    expect(await TestUniqId.count({})).toEqual(0);
  }));

  it('COULD update a doc after t.insertDoc', spec(async () => {
    await Transaction.scope(async t => {
      const a = new TestUniqId();
      await t.insertDoc(a);
      a.name = 'dad';
    });
    const a = await TestUniqId.findOne();
    expect(a.name).toEqual('dad');
  }));

  it('SHOULD start rollback when find _id conflict another transaction', spec(async () => {
    const oid = new mongoose.Types.ObjectId();
    await Transaction.scope(async t1 => {
      await t1.insertDoc(new TestUniqId({ _id: oid }));
      const transactionModel = new Transaction.getModel();
      const doc1 = await transactionModel.collection.findOne({_id: t1._id});
      expect(doc1).not.toBeNull();
      expect(doc1.rollback.length).toEqual(1);
      await Transaction.scope(async t2 => {
        await t2.insertDoc(new TestUniqId({ _id: oid }));
      });
      const doc2 = await transactionModel.collection.findOne({_id: t1._id});
      expect(doc2).toBeNull();
    });
    expect(await TestUniqId.count({})).toEqual(1);
  }));
});

describe('Transcation (recommit)', () => {
  interface ITestRecommit extends mongoose.Document {
    name: string;
    opts: any;
  }

  let TestRecommit: mongoose.Model<ITestRecommit>;

  beforeAll(spec(async() => {
    await mockgoose(mongoose);
    await new Promise(resolve => mongoose.connect('test', resolve));

    const testRecommitSchema = new mongoose.Schema({ name: String, opts: mongoose.Schema.Types.Mixed});
    testRecommitSchema.plugin(plugin);
    TestRecommit = conn.model<ITestRecommit>('TestRecommit', testRecommitSchema);
    Transaction.initialize(conn);
  }));

  afterEach(spec(async () => {
    await new Promise((resolve) => mockgoose.reset(() => resolve()));
  }));

  afterAll(spec(async() => {
    await new Promise((resolve) => (mongoose as any).unmock(resolve));
    await new Promise(resolve => mongoose.disconnect(resolve));
  }));

  it('SHOULD be able to recommit new doc', spec(async () => {
    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const tui = new TestRecommit();
    await transaction.insertDoc(tui);
    tui.name = 'baby';
    tui.opts = {'name' : 'value', 'check' : true, 'numeral' : 3};

    await (Transaction as any).makeHistory((transaction as any).participants, t);
    await Transaction.recommit(t);
    const a = await TestRecommit.findOne();
    expect(a.name).toEqual('baby');
    expect(a.opts.name).toEqual('value');
    expect(a.opts.check).toEqual(true);
    expect(a.opts.numeral).toEqual(3);
  }));

  it('SHOULD be able to recommit new doc without delta', spec(async() => {
    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const tui = new TestRecommit({name: 'dad', opts: {name: 'recommit'}});
    await transaction.insertDoc(tui);

    await (Transaction as any).makeHistory((transaction as any).participants, t);
    await Transaction.recommit(t);

    const a = await TestRecommit.findOne();
    expect(a.name).toEqual('dad');
    expect(a.opts.name).toEqual('recommit');
  }));

  it('SHOULD be able to remove doc', spec(async() => {
    const before = new TestRecommit();
    await before.save();

    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const after = await transaction.findOne(TestRecommit, {});
    await transaction.removeDoc(after);

    await (Transaction as any).makeHistory((transaction as any).participants, t);
    await Transaction.recommit(t);
    expect(await TestRecommit.count({})).toEqual(0);
  }));

  it('SHOULD be no __t when the new doc is committed', spec(async () => {
    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const tui = new TestRecommit();
    await transaction.insertDoc(tui);
    tui.name = 'baby';
    tui.opts = {'name' : 'value', 'check' : true, 'numeral' : 3};

    await (Transaction as any).makeHistory((transaction as any).participants, t);
    await Transaction.recommit(t);

    const doc = await TestRecommit.findOne();
    expect(doc['__t']).toBeUndefined();
  }));

  it('SHOULD be able to rollback new doc', spec(async () => {
    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const tui = new TestRecommit();
    await transaction.insertDoc(tui);
    tui.name = 'rollbackDoc';
    tui.opts = {'name' : 'value', 'check' : true, 'numeral' : 3};

    const transactionModel = new Transaction.getModel();
    const transactionDoc = await transactionModel.collection.findOne({});
    expect(transactionDoc.history.length).toEqual(0);
    expect(transactionDoc.rollback.length).toEqual(1);
    expect(transactionDoc.rollback[0].oid.toString()).toEqual(tui._id.toString());

    const doc1 = await TestRecommit.findOne();
    expect(doc1).not.toBeNull();

    await Transaction.recommit(t);
    const doc2 = await TestRecommit.findOne();
    expect(doc2).toBeNull();
  }));
});

describe('Transcation any Type ID', () => {
  interface ITestDoc extends mongoose.Document {
    name: string;
    opts: any;
    _id: any;
  }

  let TestAnyIdDoc: mongoose.Model<ITestDoc>;

  beforeAll(spec(async () => {
    await mockgoose(mongoose);
    await new Promise(resolve => mongoose.connect('test', resolve));

    const testSchema = new mongoose.Schema({ _id: String, name: String, opts: { status : Number } });
    testSchema.plugin(plugin);
    TestAnyIdDoc = conn.model<ITestDoc>('TestAnyId', testSchema);

    Transaction.initialize(conn);
  }));

  afterEach(spec(async () => {
    await new Promise((resolve) => mockgoose.reset(() => resolve()));
  }));

  afterAll(spec(async () => {
    await new Promise((resolve) => (mongoose as any).unmock(resolve));
    await new Promise(resolve => mongoose.disconnect(resolve));
  }));

  beforeEach(spec(async () => {
    const testDoc1 = new TestAnyIdDoc({ _id: 'jipark', name: 'Park Jiho', opts: { status: 1 } });
    const testDoc2 = new TestAnyIdDoc({ _id: 'act', name: 'Asia Central Tech', opts: { status : 2 } });
    await Transaction.scope(async (t) => {
      await t.insertDoc(testDoc1);
      await t.insertDoc(testDoc2);
    });
  }));

  it('SHOULD check Data', spec(async () => {
    expect(await TestAnyIdDoc.count({})).toEqual(2);
    const doc1 = await TestAnyIdDoc.findOne({ _id: 'jipark' }, {}).exec();
    const doc2 = await TestAnyIdDoc.findOne({ _id: 'act' }, {}).exec();
    expect(doc1.name).toEqual('Park Jiho');
    expect(doc2.name).toEqual('Asia Central Tech');
  }));

  it('should ignore calling begin() twice in silent', spec(async () => {
    await Transaction.scope(async (t) => {
      await t.begin();
      const d = await t.findOne(TestAnyIdDoc, {_id: 'jipark'});
      expect(d.name).toEqual('Park Jiho');
    });
  }));
});
