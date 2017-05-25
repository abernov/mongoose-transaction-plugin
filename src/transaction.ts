import * as mongoose from 'mongoose';
import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as _debug from 'debug';
import * as events from 'events';

const debug = _debug('transaction');
const RETRYCOUNT = 5;
const RetryTimeTable = [197, 173, 181, 149, 202];
const TRANSACTION_KEEP_COMMITTED = (process.env.TRANSACTION_KEEP_COMMITTED === 'true' || false);

export interface IHistory {
  // collection name
  col: string;
  // document's unique id
  oid: any;
  // insert, update, remove
  op: 'insert' | 'remove' | 'update';
  // update query string.
  query: string;
}

export interface ITransaction extends mongoose.Document {
  history: IHistory[];
  state: string;
  id: string;
}

interface IParticipant {
  op: 'insert' | 'remove' | 'update';
  doc: mongoose.Document;
  model?: any;
  cond?: Object;
};

export class Transaction extends events.EventEmitter {
  public static TRANSACTION_EXPIRE_THRESHOLD = 60 * 1000;
  private static model: mongoose.Model<ITransaction>;
  private static connection: mongoose.Connection;

  public static get getModel() { return Transaction.model; }

  private transaction: ITransaction;
  private participants: IParticipant[] = [];

  public static initialize(connection: mongoose.Connection) {
    if (this.model) return;

    const historySchema = new mongoose.Schema({
      col: { type: String, required: true },
      oid: { type: mongoose.Schema.Types.Mixed, required: true },
      op: { type: String, required: true },
      query: { type: String, required: true }
    });

    const transactionSchema = new mongoose.Schema({
      history: [historySchema],
      state: { type: String, required: true, default: 'init', index: true }
    });
    this.connection = connection;
    this.model = connection.model<ITransaction>('Transaction', transactionSchema);
  }

  public begin() {
    return Bluebird.try(async () => {
      if (!Transaction.model) throw new Error('Not initialized exception');
      if (this.transaction) throw new Error('Transaction has already been started');

      const transaction = new Transaction.model();
      // TODO: should be fixed mongoose.d.ts
      this.transaction = await transaction.save();
      debug('transaction created: %o', this.transaction);
      return this;
    }).catch((e: Error) => {
      // TODO we should handle every exception correctly in here,
      // otherwise the uncaught exception will make the process down.
      // Ref. http://bluebirdjs.com/docs/api/disposer.html#note-about-disposers-in-node

      // ## Possible exceptions
      // - Error('Not initialized exception')
      // - Error('Transaction has already been started')
      // - A potential error from transaction.save
      if (e.message === 'Transaction has already been started') return;

      throw e;
    }).disposer((tx, promise) => {
      if (promise.isFulfilled()) {
        return tx.commit()
          .catch(e => {
            console.log('tx.commit failed', e);
          });
      }
      return tx.cancel()
        .catch(e => {
          console.log('tx.cancel failed', e);
        });
    });
  }

  static scope<R>(doInTransactionScope: (t: Transaction) => Bluebird<R> | Promise<R>): Bluebird<R> | Promise<R> {
    return Bluebird.using<Transaction, R>(new Transaction().begin(), doInTransactionScope);
  }

  public get _id(): mongoose.Types.ObjectId {
    return this.transaction._id;
  }

  public async cancel(): Promise<void> {
    if (!this.transaction) return;
    if (this.transaction.state && this.transaction.state !== 'init') return;

    try {
      await Bluebird.each(this.participants, async (participant) => {
        if (participant.op === 'insert') {
          participant.doc['__t'] = undefined;
          return await participant.doc.remove();
        }
        return await participant.doc.update({$unset: {__t: ''}}, { w: 1 }, undefined).exec();
      });
      await this.transaction.remove();
    } catch (e) {
      debug('[warning] removing __t has been failed');
    }
    this.transaction = undefined;
    this.participants = [];
  }

  private static async commitHistory(history: IHistory, tid: mongoose.Types.ObjectId): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      return this.connection.db.collection(history.col, async function(err, collection) {
        if (err) {
          debug(`Can not find collection: ${history.col} ${err}`);
          return resolve();
        }

        if (history.op === 'remove') {
          return await collection.deleteOne({_id: history.oid}, function(err, res){
            // ignore document that already remove (case res.result.n === 0)
            if (err) {
              debug(`transaction remove failed ${err.message}`);
              return reject();
            }
            return resolve();
          });
        }

        let query = JSON.parse(history.query);

        if (history.op === 'insert') {
          delete query['_id'];
          delete query['__t'];
          console.log(JSON.stringify(query));
          return collection.update({_id: history.oid, __t: tid }, query, { w: 1 }, function(err, res) {
            if (err) {
              debug(`transaction insert operation failed [${err.message}]`);
              return reject();
            }
            return collection.update({_id:history.oid, __t:tid}, {$unset:{__t:1}}, {w:1}, function(err, res) {
              if (err) {
                debug(`transaction insert operation 2 failed [${err.message}]`);
               return reject();
              }
              return resolve();
            });
          });
        }
        
        query['$unset'] = query['$unset'] || {};
        query['$set'] = query['$set'] || {};
        if (query['$set']['__t'])
          delete query['$set']['__t'];
        if (query['$set']['_id'])
          delete query['$set']['_id'];
        
        if (Object.keys(query['$set']).length === 0)
          delete query['$set'];

        query['$unset']['__t'] = '';
        debug('update recommit query is : ', query);

        return collection.update({_id: history.oid, __t: tid }, query, { w: 1 }, function(err, res) {
          if (err) {
            debug(`transaction update failed [${err.message}]`);
            return reject();
          }
          // ignore document that already update or insert (case res.result.n === 0)
          return resolve();
        });
      });
    });
  }

  public static async recommit(transaction: ITransaction): Promise<void> {
    const histories = transaction.history;
    if (!histories) return;

    try {
      await Bluebird.each(histories, async (history) => {
        debug('find history collection: ', history.col, ' oid: ', history.oid);
        await Transaction.commitHistory(history, transaction._id);
      });
      debug('transaction recommited!');
      // TRANSACTION_KEEP_COMMITTED 값에 따라 Transaction Document를 지우거나 갱신한다.
      if (!TRANSACTION_KEEP_COMMITTED) {
        await transaction.remove();
      } else {
        transaction.state = 'recommited';
        await transaction.save();
      }
    } catch (err) {
      // 하나라도 실패하면 pending 상태로 recommit 처리된다.
      debug('Fails to save whole transactions but they will be saved', err);
    }
  }

  private static async validate(doc: any): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      return doc.validate(err => err && reject(err) || resolve());
    });
  }

  private static async makeHistory(participants: IParticipant[], transaction: ITransaction) {
    await Bluebird.each(participants, async (participant) => {
      // TODO: should be fixed mongoose.d.ts
      await Transaction.validate(participant.doc);

      let query: string;
      if (participant.op === 'update') {
        query = JSON.stringify(((<any>participant.doc).$__delta() || [null, {}])[1]);
      } else if (participant.op === 'remove') {
        query = JSON.stringify({ _id: '' });
      } else if (participant.op === 'insert') {
        query = JSON.stringify(participant.doc);
      }
      debug(`op : ${participant.op}, query: ${JSON.stringify(query)}`);
      
      transaction.history.push({
        col: (<any>participant.doc).collection.name,
        oid: participant.doc._id,
        op: participant.op,
        query: query
      });
    });
  }

  public async commit(): Promise<void> {
    if (!this.transaction) return;

    await Transaction.makeHistory(this.participants, this.transaction);
    debug('history generated: %o', this.transaction.history);

    this.transaction.state = 'pending';
    try {
      this.transaction = await this.transaction.save();
    } catch (err) {
      this.transaction.state = 'init';
      throw err;
    }

    debug('apply participants\' changes');
    try {
      await Bluebird.map(this.participants, async (participant) => {
        if (participant.op === 'remove') return await participant.doc.remove();
        else return await participant.doc.save();
      });

      debug('transaction committed');
      // TRANSACTION_KEEP_COMMITTED 값에 따라 Transaction Document를 지우거나 갱신한다.
      if (!TRANSACTION_KEEP_COMMITTED) {
        await this.transaction.remove();
      } else {
        this.transaction.state = 'committed';
        await this.transaction.save();
      }
    } catch (err) {
      // 하나라도 실패하면 pending 상태로 recommit 처리된다.
      debug('Fails to save whole transactions but they will be saved', err);
    }

    this.transaction = undefined;
    this.participants = [];
  }

  // 생성될 document를 transaction에 참가시킴
  public async insertDoc(doc: mongoose.Document) {
    if (!this.transaction) throw new Error('Could not find any transaction');

    doc['__t'] = this.transaction._id;
    await doc.collection.insert(doc);
    
    this.participants.push({ op: 'insert', doc: doc });
  }

  // 삭제할 document를 transaction에 참가시킴
  public async removeDoc(doc: mongoose.Document) {
    if (!this.transaction) throw new Error('Could not find any transaction');

    const id: mongoose.Types.ObjectId = doc['__t'];
    if (!id || id.toHexString() !== this.transaction.id) throw new Error('Already other locked');

    this.participants.push({ op: 'remove', doc: doc });
  }

  public async findOne<T extends mongoose.Document>(model: mongoose.Model<T>, cond: Object, fields?: Object, options?: Object): Promise<T> {
    if (!this.transaction) throw new Error('Could not find any transaction');

    const p = _.find(this.participants, p => {
      return p.model === model && JSON.stringify(cond) === JSON.stringify(p.cond);
    });
    if (p && p.doc) return p.doc as T;

    if (!options) options = { retrycount: RETRYCOUNT };
    if (options['retrycount'] === undefined) {
      debug('set retrycount ', options, options['retrycount']);
      options['retrycount'] = RETRYCOUNT;
    }

    const opt = _.cloneDeep(options || {});
    opt['__t'] = this.transaction._id;
    opt['tModel'] = Transaction.getModel;
    opt['transaction'] = true;

    debug('tModel before ', opt['tModel'].collection.name);

    debug('attempt write lock', _.omit(opt, 'tModel'));
    let doc: T;
    try {
      doc = await model.findOne(cond, fields, opt).exec();
    } catch (err) {
      debug('transaction err : retrycount is ', options['retrycount']);
      if (err.message !== 'write lock' || options['retrycount'] === 0) throw err;

      options['retrycount'] -= 1;
      await Bluebird.delay(RetryTimeTable[Math.floor(Math.random() * RetryTimeTable.length)]);
      return await this.findOne(model, cond, fields, options);
    }
    if (!doc) return;

    const withSameId = _.find(this.participants, p => {
      return p.model === model && p.doc._id.equals(doc._id);
    });
    if (withSameId) return withSameId.doc as T;

    this.participants.push({op: 'update', doc: doc, model: model, cond: cond});
    
    return doc;
  }
}
