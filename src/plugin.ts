import * as mongoose from 'mongoose';
import * as _debug from 'debug';
import * as _ from 'lodash';

import { Transaction } from './transaction';
(mongoose as any).Promise = Promise;

const debug = _debug('transaction');

export interface TxDocument extends mongoose.Document {
  __t?: mongoose.Types.ObjectId;
  // __new?: boolean;
}

class PreFindOne {
  schema: any;

  constructor (schema) {
    this.schema = schema;
  }

  get options() {
    return this.schema.options;
  }

  get model() {
    return this.schema.model;
  }

  get _conditions() {
    return this.schema._conditions;
  }

  get _fields() {
    return this.schema._fields;
  }

  checkInSameTransaction(newTid, oldTid) {
    if (!oldTid) return false;
    if (newTid && newTid.equals(oldTid)) {
      debug('already locked: ', oldTid);
      return true;
    }
    return false;
  }

  isExpired(tid) {
    const docTime = tid.getTimestamp();
    const current = new Date().getTime();
    debug('timestamp! ', docTime, current, current - docTime);

    return (current - docTime) >= 30000;
  }

  async recommitTransaction(tModel, t) {
    debug('recommit transaction');
    await Transaction.recommit(t);
    await tModel.update({_id: t._id}, {state: 'committed'}, {w: 1}).exec();
  }

  cancelTransaction(tModel, tid) {
    debug('cancel transaction');
    tModel.update({_id: tid}, {state: 'canceled'}, {w: 1}).exec();
  }

  async resolvePreviousTransaction(tid) {
    const tModel = this.options.tModel;
    debug('tModel is ', tModel.collection.name);

    if (!this.isExpired(tid)) return; // let it be conflicted

    const transaction = await tModel.findOne({_id: tid}).exec();
    if (!transaction) throw new Error('There is no transaction history.');

    debug('find Transaction ', transaction, transaction.state);
    switch (transaction.state) {
      case 'init':
        this.cancelTransaction(tModel, tid);
        return tid;

      case 'pending':
        await this.recommitTransaction(tModel, transaction);
        return {'$exists': false};

      case 'committed':
        debug('already committed. ignore __t');
        return tid;

      case 'canceled':
        // TODO :  비정상 상태로 인하여 canceled가 남는 경우 transcation document는 제거 되지 않고 현재 남겨져 있다.
        debug('already canceled. ignore __t');
        return tid;
    }
  }

  isUpdateSuccessfully(rawResponse) {
    return rawResponse.n > 0 && rawResponse.nModified > 0 && rawResponse.n === rawResponse.nModified;
  }

  async update(query) {
    const rawResponse = await this.model.update(this._conditions, query, {
      force: true,
      w: 1
    }).exec();
    debug('rawResponse: %o', rawResponse);
    if (!this.isUpdateSuccessfully(rawResponse)) {
      throw new Error('write lock');
    }
  }

  async getMinimalDoc(conditions) {
    return this.model.findOne(conditions, {_id: 1, __t: 1}).exec();
  }

  async run() {
    if (!this.options.transaction) return;
    if (this.options.transaction && !this.options.__t) throw new Error('Called `findOne` outside of a transaction');

    debug('pre-findOne');
    debug('options: %o', _.omit(this.options, 'tModel'));
    debug('conditions: %o', this._conditions);

    const doc = await this.getMinimalDoc(this._conditions);
    if (!doc) return;
    debug('document found! t : ', doc.__t, ', id : ', doc.id);

    if (this.checkInSameTransaction(this.options.__t, doc.__t)) return;

    this._conditions['_id'] = doc._id;
    this._conditions['__t'] = {$exists: false};
    if (doc.__t) {
      this._conditions['__t'] = await this.resolvePreviousTransaction(doc.__t);
    }
    debug('conditions are modified', this._conditions);

    const updateQuery = {__t: this.options.__t};
    debug('update query is modified %o', updateQuery);
    await this.update(updateQuery);

    debug('locking success');
    delete this._conditions['__t'];
    debug('rollback conditions', this._conditions);
    if (this._fields) this._fields['__t'] = 1;
  }
}

function ensureNoUnique(schema) {
  const indexes = schema.indexes();
  const shardKey = schema.options.shardKey && Object.keys(schema.options.shardKey)[0];
  indexes.forEach(([name, options]) => {
    if (options && options.unique) {
      if (typeof name === 'object') {
        name = Object.keys(name)[0];
      }
      if (name !== shardKey)
        throw new Error(`Transaction doesn't support an unique index (${name}) shardKey (${shardKey})`);
    }
  });
}

export function plugin(schema: mongoose.Schema, options?: Object) {
  ensureNoUnique(schema);

  schema.add({
    __t: { type: mongoose.Schema.Types.ObjectId },
    // __new: { type: Boolean, default: true }
  });

  const oldIndexMethod: any = schema.index;
  schema.index = function (...args) {
    const res = oldIndexMethod.apply(this, args);
    ensureNoUnique(schema);
    return res;
  };

  schema.pre('save', function(next) {
    debug('pre-save');
    debug('checking __t field: ', this.__t);
    if (!this.__t && !this.isNew) return next(new Error('You can\' not save without lock'));

    // TODO:
    // if (this.__t.toString().substring(8, 18) !== '0000000000') return next(new Error(''));
    this.__t = undefined;
    next();
  });

  schema.pre('findOne', async function (next) {
    const o = new PreFindOne(this);
    try {
      await o.run();
      next();
    } catch (e) {
      next(e);
    }
  });
}
