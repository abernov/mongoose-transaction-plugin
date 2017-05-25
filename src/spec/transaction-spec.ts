import 'source-map-support/register';
import * as mongoose from 'mongoose';
import * as Bluebird from 'bluebird';
import * as _debug from 'debug';
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

xdescribe('Transaction-static', () => {
  it('should throw by use of begin() before initialize', spec(async () => {
    let tx;
    tx = new Transaction();
    // await tx.begin();
    // this will process down
  }));
  it('should not allow an unique index', spec(async () => {
    expect(() => {
      new mongoose.Schema({ name: String }).index('name', {unique: true}).plugin(plugin);
    }).toThrowError(`Transaction doesn't support an unique index (name)`);

    expect(() => {
      new mongoose.Schema({ type: { type: Number, index: true, unique: true } }).plugin(plugin);
    }).toThrowError(`Transaction doesn't support an unique index (type)`);

    expect(() => {
      new mongoose.Schema({ type: { type: Number, index: true } }).plugin(plugin);
    }).not.toThrowError(`Transaction doesn't support an unique index (type)`);

    expect(() => {
      new mongoose.Schema({ name: String }).plugin(plugin).index('name', {unique: true});
    }).toThrowError(`Transaction doesn't support an unique index (name)`);
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

xdescribe('Transaction', () => {
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

  xit('should index state', spec(async () => {
    const indexes = Transaction.getModel.schema.indexes();
    const [fields, options] = indexes[0];
    expect(fields.state).toEqual(1);
    expect(options.background).toBeTruthy();
  }));

  xit('should ignore calling begin() twice in silent', spec(async () => {
    await Transaction.scope(async (t) => {
      await t.begin();
      const d = await t.findOne(TestPlayer, {name: 'ekim'});
      expect(d.name).toEqual('ekim');
    });
  }));

  xit('could use write lock', spec(async () => {
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

  xit('should not allow `Model.findOne` with transaction out of a transaction disposer', spec(async () => {
    try {
      await TestPlayer.findOne({ name: 'ekim' }, {}, { transaction: true }).exec();
      expect(true).toEqual(false);
    } catch (e) {
      expect(() => {
        throw e;
      }).toThrow();
    }
  }));

  xit('could commit two documents in same transaction', spec(async () => {
    await Transaction.scope(async (tx) => {
      const testPlayer = await tx.findOne(TestPlayer, { name: 'wokim' });
      debug('locking success: %o', testPlayer);
      testPlayer.money += 600;
    });
    expect(1).toBe(1);
  }));

  xit('can not save without lock', spec(async () => {
    const doc = await TestPlayer.findOne({ name: 'ekim' }, {}).exec();
    expect(doc['__t']).toBeUndefined();
    // console.log('doc is ', doc);
    // console.log('save document to detatch __t');
    try {
      await doc.save();
      expect(true).toEqual(false);
    } catch (e) {
      expect(true).toEqual(true);
    }
  }));

  xit('duplicate findOne with One Transaction', spec(async () => {
    console.log('duplicate findOne with One Transaction');
    await Transaction.scope(async (t) => {
      const doc = await t.findOne(TestPlayer, { name: 'ekim' });
      expect(doc['__t']).toBeDefined();
      console.log('first doc is ', doc);
      doc.money += 500;
      const secondTry = await t.findOne(TestPlayer, { name: 'ekim' });
      console.log('second doc is ', doc);
      secondTry.money += 1000;
    });
    const doc = await TestPlayer.findOne({ name: 'ekim' }, {}).exec();
    console.log(doc.money);
    expect(doc.money).toBe(1500);
  }));

  xit('duplicate findOne with other conditions', spec(async () => {
    await Transaction.scope(async (t) => {
      const doc = await t.findOne(TestPlayer, { name: 'ekim' });
      expect(doc['__t']).toBeDefined();
      // console.log('first doc is ', doc);
      doc.money += 500;
      const sameButDiffConditionDoc = await t.findOne(TestPlayer, { age: 10 });
      // console.log('second doc is ', doc);
      sameButDiffConditionDoc.money += 1000;
    });
    const doc = await TestPlayer.findOne({ name: 'ekim' }, {}).exec();
    expect(doc.money).toBe(1500);
  }));

  xit('should save new document without transaction', spec(async () => {
    const doc = new TestPlayer({ name: 'newbie', age: 1 });
    try {
      await doc.save();
      expect(true).toEqual(true);
    } catch (e) {
      expect(e).toBeUndefined();
    }
  }));

  xit('should retry when it finds a live transaction', done => {
    function addMoney(name: string, money: number) {
      return Transaction.scope(t => {
        return t.findOne(TestPlayer, { name: name })
          .then(doc => {
            doc.money += money;
            // console.log('addMoney!!!!! ', doc.money);
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

  xit('delete all document', spec(async () => {
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

  xit('should throw an error to resolve an expired transaction with no history', spec(async () => {
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

  xit('should cancel expired transaction which is stated as `init`', spec(async () => {
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

  xit('should recommit when it finds an old pending transaction', spec(async () => {
    const oldTransaction = new Transaction.getModel();
    oldTransaction._id = ObjectId.get(+new Date('2016-01-01'));
    oldTransaction.state = 'pending';

    const ekim = await TestPlayer.findOne({ name: 'ekim' });
    oldTransaction.history.push({
      col: TestPlayer.collection.name,
      oid: ekim._id,
      op: 'update',
      query: JSON.stringify({ $set: { money: 1000 } })
    });
    await oldTransaction.save();
    await TestPlayer.collection.update({ name: 'ekim' }, { $set: { __t: oldTransaction._id } });

    await Transaction.scope(async (t) => {
      const doc = await t.findOne(TestPlayer, { name: 'ekim' });
      expect(doc.money).toEqual(1000);

      const transaction = await Transaction.getModel.findOne({ _id: oldTransaction._id });
      expect(transaction.state).toEqual('committed');
    });
  }));

  xit('should cancel transaction if the handler throws', spec(async () => {
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

xdescribe('Transaction(_id uniqueness)', () => {
  interface ITestUniqIdx extends mongoose.Document {
    name: string;
  }

  let TestUniqIdx: mongoose.Model<ITestUniqIdx>;
  beforeAll(spec(async () => {
    await mockgoose(mongoose);
    await new Promise(resolve => mongoose.connect('test', resolve));

    const testUniqIdxSchema = new mongoose.Schema({ name: String, type: String });
    testUniqIdxSchema.plugin(plugin);
    TestUniqIdx = conn.model<ITestUniqIdx>('TestUniqIdx', testUniqIdxSchema);

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
        await t.insertDoc(new TestUniqIdx({ _id: oid }));
        await t.insertDoc(new TestUniqIdx({ _id: oid }));
      });
    });
    expect(await TestUniqIdx.count({})).toEqual(0);
  }));

  it('COULD update a doc after t.insertDoc', spec(async () => {
    await Transaction.scope(async t => {
      const a = new TestUniqIdx();
      await t.insertDoc(a);
      a.name = 'david';
    });
    const a = await TestUniqIdx.findOne();
    expect(a.name).toEqual('david');
  }));
});

describe('Transaction(recommit)', () => {
  interface ITestRecommit extends mongoose.Document {
    name: string;
  }

  let TestRecommit: mongoose.Model<ITestRecommit>;
  beforeAll(spec(async () => {
    await mockgoose(mongoose);
    await new Promise(resolve => mongoose.connect('test', resolve));

    const testRecommitSchema = new mongoose.Schema({ name: String, type: String });
    testRecommitSchema.plugin(plugin);
    TestRecommit = conn.model<ITestRecommit>('TestRecommit', testRecommitSchema);

    Transaction.initialize(conn);
  }));

  afterEach(spec(async () => {
    await new Promise((resolve) => mockgoose.reset(() => resolve()));
  }));

  afterAll(spec(async () => {
    await new Promise((resolve) => (mongoose as any).unmock(resolve));
    await new Promise(resolve => mongoose.disconnect(resolve));
  }));

  it('SHOULD be able to recommit new doc', spec(async () => {
    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const tui = new TestRecommit();
    await transaction.insertDoc(tui);
    tui.name = 'XXXXX1';

    await (Transaction as any).makeHistory((transaction as any).participants, t);
    //console.log(t);
    await Transaction.recommit(t);
    const a = await TestRecommit.findOne();
    //console.log(a);
    expect(a.name).toEqual('XXXXX1');
  }));

  it('SHOULD be able to recommit new doc without delta', spec(async () => {
    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const tui = new TestRecommit({name: 'XXXXX2'});
    await transaction.insertDoc(tui);
    //console.log('asdfasdf', await TestRecommit.findOne());

    await (Transaction as any).makeHistory((transaction as any).participants, t);
    //console.log(t);
    await Transaction.recommit(t);
    const a = await TestRecommit.findOne();
    console.log(a);
    expect(a.name).toEqual('XXXXX2');
  }));

  it('SHOULD be able to remove doc', spec(async () => {
    console.log('SHOULD be able to remove doc');
    const before = new TestRecommit();
    await before.save();
    //console.log('1>> ' + await TestRecommit.count({}));
    const transaction = new Transaction();
    const t = new Transaction.getModel();
    (transaction as any).transaction = await t.save();
    const after = await transaction.findOne(TestRecommit, {});
    await transaction.removeDoc(after);

    await (Transaction as any).makeHistory((transaction as any).participants, t);
    //console.log("t > " + t);
    await Transaction.recommit(t);
    //console.log('2>> ' + await TestRecommit.count({}));
    expect(await TestRecommit.count({})).toEqual(0);
  }));
});
