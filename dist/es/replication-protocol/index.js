/**
 * These files contain the replication protocol.
 * It can be used to replicated RxStorageInstances or RxCollections
 * or even to do a client(s)-server replication.
 */

import { BehaviorSubject, combineLatest, filter, firstValueFrom, map, Subject } from 'rxjs';
import { getPrimaryFieldOfPrimaryKey } from '../rx-schema-helper';
import { ensureNotFalsy, PROMISE_RESOLVE_VOID } from '../plugins/utils';
import { getCheckpointKey } from './checkpoint';
import { startReplicationDownstream } from './downstream';
import { docStateToWriteDoc, writeDocToDocState } from './helper';
import { startReplicationUpstream } from './upstream';
export * from './checkpoint';
export * from './downstream';
export * from './upstream';
export * from './meta-instance';
export * from './conflicts';
export * from './helper';
export function replicateRxStorageInstance(input) {
  var checkpointKey = getCheckpointKey(input);
  var state = {
    primaryPath: getPrimaryFieldOfPrimaryKey(input.forkInstance.schema.primaryKey),
    input,
    checkpointKey,
    downstreamBulkWriteFlag: 'replication-downstream-' + checkpointKey,
    events: {
      canceled: new BehaviorSubject(false),
      active: {
        down: new BehaviorSubject(true),
        up: new BehaviorSubject(true)
      },
      processed: {
        down: new Subject(),
        up: new Subject()
      },
      resolvedConflicts: new Subject(),
      error: new Subject()
    },
    stats: {
      down: {
        addNewTask: 0,
        downstreamProcessChanges: 0,
        downstreamResyncOnce: 0,
        masterChangeStreamEmit: 0,
        persistFromMaster: 0
      },
      up: {
        forkChangeStreamEmit: 0,
        persistToMaster: 0,
        persistToMasterConflictWrites: 0,
        persistToMasterHadConflicts: 0,
        processTasks: 0,
        upstreamInitialSync: 0
      }
    },
    firstSyncDone: {
      down: new BehaviorSubject(false),
      up: new BehaviorSubject(false)
    },
    streamQueue: {
      down: PROMISE_RESOLVE_VOID,
      up: PROMISE_RESOLVE_VOID
    },
    checkpointQueue: PROMISE_RESOLVE_VOID,
    lastCheckpointDoc: {}
  };
  startReplicationDownstream(state);
  startReplicationUpstream(state);
  return state;
}
export function awaitRxStorageReplicationFirstInSync(state) {
  return firstValueFrom(combineLatest([state.firstSyncDone.down.pipe(filter(v => !!v)), state.firstSyncDone.up.pipe(filter(v => !!v))])).then(() => {});
}
export function awaitRxStorageReplicationInSync(replicationState) {
  return Promise.all([replicationState.streamQueue.up, replicationState.streamQueue.down, replicationState.checkpointQueue]);
}
export async function awaitRxStorageReplicationIdle(state) {
  await awaitRxStorageReplicationFirstInSync(state);
  while (true) {
    var {
      down,
      up
    } = state.streamQueue;
    await Promise.all([up, down]);
    /**
     * If the Promises have not been reasigned
     * after awaiting them, we know that the replication
     * is in idle state at this point in time.
     */
    if (down === state.streamQueue.down && up === state.streamQueue.up) {
      return;
    }
  }
}
export function rxStorageInstanceToReplicationHandler(instance, conflictHandler, databaseInstanceToken) {
  var primaryPath = getPrimaryFieldOfPrimaryKey(instance.schema.primaryKey);
  var replicationHandler = {
    masterChangeStream$: instance.changeStream().pipe(map(eventBulk => {
      var ret = {
        checkpoint: eventBulk.checkpoint,
        documents: eventBulk.events.map(event => {
          return writeDocToDocState(ensureNotFalsy(event.documentData));
        })
      };
      return ret;
    })),
    masterChangesSince(checkpoint, batchSize) {
      return instance.getChangedDocumentsSince(batchSize, checkpoint).then(result => {
        return {
          checkpoint: result.documents.length > 0 ? result.checkpoint : checkpoint,
          documents: result.documents.map(d => writeDocToDocState(d))
        };
      });
    },
    async masterWrite(rows) {
      var rowById = {};
      rows.forEach(row => {
        var docId = row.newDocumentState[primaryPath];
        rowById[docId] = row;
      });
      var ids = Object.keys(rowById);
      var masterDocsState = await instance.findDocumentsById(ids, true);
      var conflicts = [];
      var writeRows = [];
      await Promise.all(Object.entries(rowById).map(async ([id, row]) => {
        var masterState = masterDocsState[id];
        if (!masterState) {
          writeRows.push({
            document: docStateToWriteDoc(databaseInstanceToken, row.newDocumentState)
          });
        } else if (masterState && !row.assumedMasterState) {
          conflicts.push(writeDocToDocState(masterState));
        } else if ((await conflictHandler({
          realMasterState: writeDocToDocState(masterState),
          newDocumentState: ensureNotFalsy(row.assumedMasterState)
        }, 'rxStorageInstanceToReplicationHandler-masterWrite')).isEqual === true) {
          writeRows.push({
            previous: masterState,
            document: docStateToWriteDoc(databaseInstanceToken, row.newDocumentState, masterState)
          });
        } else {
          conflicts.push(writeDocToDocState(masterState));
        }
      }));
      if (writeRows.length > 0) {
        var result = await instance.bulkWrite(writeRows, 'replication-master-write');
        Object.values(result.error).forEach(err => {
          if (err.status !== 409) {
            throw new Error('non conflict error');
          } else {
            conflicts.push(writeDocToDocState(ensureNotFalsy(err.documentInDb)));
          }
        });
      }
      return conflicts;
    }
  };
  return replicationHandler;
}
export function cancelRxStorageReplication(replicationState) {
  replicationState.events.canceled.next(true);
  replicationState.events.active.up.complete();
  replicationState.events.active.down.complete();
  replicationState.events.processed.up.complete();
  replicationState.events.processed.down.complete();
  replicationState.events.resolvedConflicts.complete();
  replicationState.events.canceled.complete();
}
//# sourceMappingURL=index.js.map