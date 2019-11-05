import BigNumber from 'bignumber.js'
import { keccak256 } from 'ethereumjs-util'
import { identity } from 'fp-ts/lib/function'
import Contract from 'web3/eth/contract'

import { mapAsync, zip } from '@celo/utils/lib/collections'

import { Address } from '../base'
import { Governance } from '../generated/types/Governance'
import {
  BaseWrapper,
  CeloTransactionObject,
  parseBuffer,
  parseNumber,
  proxyCall,
  proxySend,
  toBigNumber,
  toBuffer,
  toTransactionObject,
  tupleParser,
} from './BaseWrapper'

export interface StageDurations {
  approval: BigNumber // seconds
  referendum: BigNumber // seconds
  execution: BigNumber // seconds
}

export interface GovernanceConfig {
  concurrentProposals: BigNumber
  dequeueFrequency: BigNumber // seconds
  minDeposit: BigNumber
  queueExpiry: BigNumber // seconds
  stageDurations: StageDurations
}

export interface Transaction {
  value: BigNumber
  destination: Address
  data: Buffer
}

interface TransactionsEncoded {
  readonly values: string[]
  readonly destinations: Address[]
  readonly data: Buffer
  readonly dataLengths: number[]
}

export interface ProposalMetadata {
  proposer: Address
  deposit: BigNumber
  timestamp: BigNumber
  transactionCount: number
}

export interface Proposal {
  metadata: ProposalMetadata
  transactions: Transaction[]
}

interface QueueProposal {
  id: BigNumber
  upvotes: BigNumber
}

interface UpvoteRecord {
  id: BigNumber
  weight: BigNumber
}

export enum VoteValue {
  None,
  Abstain,
  No,
  Yes,
}

const ZERO_BN = new BigNumber(0)

/**
 * Contract managing voting for governance proposals.
 */
export class GovernanceWrapper extends BaseWrapper<Governance> {
  /**
   * Querying number of possible concurrent proposals.
   * @returns Current number of possible concurrent proposals.
   */
  concurrentProposals = proxyCall(this.contract.methods.concurrentProposals, undefined, toBigNumber)
  /**
   * Query proposal dequeue frequency.
   * @returns Current proposal dequeue frequency in seconds.
   */
  dequeueFrequency = proxyCall(this.contract.methods.dequeueFrequency, undefined, toBigNumber)
  /**
   * Query minimum deposit required to make a proposal.
   * @returns Current minimum deposit.
   */
  minDeposit = proxyCall(this.contract.methods.minDeposit, undefined, toBigNumber)
  /**
   * Query queue expiry parameter.
   * @return The number of seconds a proposal can stay in the queue before expiring.
   */
  queueExpiry = proxyCall(this.contract.methods.queueExpiry, undefined, toBigNumber)
  /**
   * Query durations of different stages in proposal lifecycle.
   * @returns Durations for approval, referendum and execution stages in seconds.
   */
  async stageDurations(): Promise<StageDurations> {
    const res = await this.contract.methods.stageDurations().call()
    return {
      approval: toBigNumber(res[0]),
      referendum: toBigNumber(res[1]),
      execution: toBigNumber(res[2]),
    }
  }

  /**
   * Returns current configuration parameters.
   */
  async getConfig(): Promise<GovernanceConfig> {
    const res = await Promise.all([
      this.concurrentProposals(),
      this.dequeueFrequency(),
      this.minDeposit(),
      this.queueExpiry(),
      this.stageDurations(),
    ])
    return {
      concurrentProposals: res[0],
      dequeueFrequency: res[1],
      minDeposit: res[2],
      queueExpiry: res[3],
      stageDurations: res[4],
    }
  }

  getProposalMetadata: (proposalID: BigNumber) => Promise<ProposalMetadata> = proxyCall(
    this.contract.methods.getProposal,
    tupleParser(parseNumber),
    (res) => ({
      proposer: res[0],
      deposit: toBigNumber(res[1]),
      timestamp: toBigNumber(res[2]),
      transactionCount: toBigNumber(res[3]).toNumber(),
    })
  )

  getProposalTransaction: (
    proposalID: BigNumber,
    txIndex: number
  ) => Promise<Transaction> = proxyCall(
    this.contract.methods.getProposalTransaction,
    tupleParser(parseNumber, parseNumber),
    (res) => ({
      value: toBigNumber(res[0]),
      destination: res[1],
      // @ts-ignore string[] bytes type
      data: toBuffer(res[2]),
    })
  )

  async getProposal(proposalID: BigNumber): Promise<Proposal> {
    const metadata = await this.getProposalMetadata(proposalID)
    const txIndices = Array.from(Array(metadata.transactionCount).keys())
    const transactions = await mapAsync(txIndices, (txIndex) =>
      this.getProposalTransaction(proposalID, txIndex)
    )

    return {
      metadata,
      transactions,
    }
  }

  private getTransactionsEncoded(transactions: Transaction[]): TransactionsEncoded {
    return {
      values: transactions.map((tx) => tx.value.toString()),
      destinations: transactions.map((tx) => tx.destination),
      data: Buffer.concat(transactions.map((tx) => tx.data)),
      dataLengths: transactions.map((tx) => tx.data.length),
    }
  }

  getTransactionsHash(transactions: Transaction[]): Buffer {
    const encoded = this.getTransactionsEncoded(transactions)
    return keccak256(
      this.kit.web3.eth.abi.encodeParameters(
        ['uint256[]', 'address[]', 'bytes', 'uint256[]'],
        [encoded.values, encoded.destinations, encoded.data, encoded.dataLengths]
      )
    ) as Buffer
  }

  // TODO(yorke): re-type keeping in mind CLI (simple inputs: contract name, method name, and args)
  toTransactionData<T extends Contract, K extends keyof T['methods'], M extends T['methods'][K]>(
    contractMethod: M,
    args: Parameters<M>
  ) {
    return toBuffer(contractMethod(...args).encodeABI())
  }

  propose(transactions: Transaction[]) {
    const encoded = this.getTransactionsEncoded(transactions)
    return toTransactionObject(
      this.kit,
      this.contract.methods.propose(
        encoded.values,
        encoded.destinations,
        // @ts-ignore bytes type
        encoded.data,
        encoded.dataLengths
      )
    )
  }

  proposalExists: (proposalID: BigNumber) => Promise<boolean> = proxyCall(
    this.contract.methods.proposalExists,
    tupleParser(parseNumber),
    identity
  )

  getUpvoteRecord: (upvoter: Address) => Promise<UpvoteRecord> = proxyCall(
    this.contract.methods.getUpvoteRecord,
    tupleParser(identity),
    (o) => ({
      id: toBigNumber(o[0]),
      weight: toBigNumber(o[1]),
    })
  )

  isQueued = proxyCall(this.contract.methods.isQueued, tupleParser(parseNumber), identity)

  getUpvotes = proxyCall(this.contract.methods.getUpvotes, tupleParser(parseNumber), toBigNumber)

  getQueue = proxyCall(this.contract.methods.getQueue, undefined, (arraysObject) =>
    zip<string, string, QueueProposal>(
      (_id, _upvotes) => ({
        id: toBigNumber(_id),
        upvotes: toBigNumber(_upvotes),
      }),
      arraysObject[0],
      arraysObject[1]
    )
  )

  // TODO: merge with SortedOracles/Election findLesserAndGreater
  // proposalID is zero for revokes
  async findLesserAndGreaterAfterUpvote(proposalID: BigNumber, upvoter: Address) {
    let queue = await this.getQueue()
    let searchID = ZERO_BN

    const upvoteRecord = await this.getUpvoteRecord(upvoter)
    // does upvoter have a previous upvote?
    if (upvoteRecord.id.isGreaterThan(ZERO_BN)) {
      const proposalIdx = queue.findIndex((qp) => qp.id.isEqualTo(upvoteRecord.id))
      // is previous upvote in queue?
      if (proposalIdx !== -1) {
        queue[proposalIdx].upvotes = queue[proposalIdx].upvotes.minus(upvoteRecord.weight)
        searchID = upvoteRecord.id
      }
    }

    // is upvoter targeting a valid proposal?
    if (proposalID.isGreaterThan(ZERO_BN)) {
      const proposalIdx = queue.findIndex((qp) => qp.id.isEqualTo(proposalID))
      // is target proposal in queue?
      if (proposalIdx !== -1) {
        const accountsContract = await this.kit.contracts.getAccounts()
        const votingAccount = await accountsContract.getVoteSigner(upvoter)
        const lockedGoldContract = await this.kit.contracts.getLockedGold()
        const weight = await lockedGoldContract.getAccountTotalLockedGold(votingAccount)
        // const weight = 1
        queue[proposalIdx].upvotes = queue[proposalIdx].upvotes.plus(weight)
        searchID = proposalID
      } else {
        throw new Error(`Proposal ${proposalID.toString()} not in queue`)
      }
    }

    queue = queue.sort((a, b) => a.upvotes.comparedTo(b.upvotes))
    const newIdx = queue.findIndex((qp) => qp.id.isEqualTo(searchID))

    return {
      lesserID: newIdx === 0 ? ZERO_BN : queue[newIdx - 1].id,
      greaterID: newIdx === queue.length - 1 ? ZERO_BN : queue[newIdx + 1].id,
    }
  }

  async upvote(proposalID: BigNumber, upvoter: Address) {
    const exists = await this.proposalExists(proposalID)
    if (!exists) {
      throw new Error(`Proposal ${proposalID.toString()} does not exist`)
    }
    const { lesserID, greaterID } = await this.findLesserAndGreaterAfterUpvote(proposalID, upvoter)
    return toTransactionObject(
      this.kit,
      this.contract.methods.upvote(
        proposalID.toString(),
        lesserID.toString(),
        greaterID.toString()
      ),
      { from: upvoter }
    )
  }

  async revokeUpvote(upvoter: Address) {
    const { id } = await this.getUpvoteRecord(upvoter)
    if (!id.isGreaterThan(ZERO_BN)) {
      throw new Error(`Voter ${upvoter} has no upvote to revoke`)
    }
    const { lesserID, greaterID } = await this.findLesserAndGreaterAfterUpvote(ZERO_BN, upvoter)
    return toTransactionObject(
      this.kit,
      this.contract.methods.revokeUpvote(lesserID.toString(), greaterID.toString()),
      { from: upvoter }
    )
  }

  approve: (
    proposalID: BigNumber,
    proposalIndex: BigNumber
  ) => CeloTransactionObject<boolean> = proxySend(
    this.kit,
    this.contract.methods.approve,
    tupleParser(parseNumber, parseNumber)
  )

  vote: (
    proposalID: BigNumber,
    proposalIndex: BigNumber,
    vote: VoteValue
  ) => CeloTransactionObject<boolean> = proxySend(
    this.kit,
    this.contract.methods.vote,
    tupleParser(parseNumber, parseNumber, identity)
  )

  execute: (
    proposalID: BigNumber,
    proposalIndex: BigNumber
  ) => CeloTransactionObject<boolean> = proxySend(
    this.kit,
    this.contract.methods.execute,
    tupleParser(parseNumber, parseNumber)
  )

  whitelistHotfix: (hash: Buffer) => CeloTransactionObject<void> = proxySend(
    this.kit,
    this.contract.methods.whitelistHotfix,
    tupleParser(parseBuffer)
  )

  approveHotfix: (hash: Buffer) => CeloTransactionObject<void> = proxySend(
    this.kit,
    this.contract.methods.approveHotfix,
    tupleParser(parseBuffer)
  )

  prepareHotfix: (hash: Buffer) => CeloTransactionObject<void> = proxySend(
    this.kit,
    this.contract.methods.prepareHotfix,
    tupleParser(parseBuffer)
  )

  executeHotfix(transactions: Transaction[]) {
    const encoded = this.getTransactionsEncoded(transactions)
    return toTransactionObject(
      this.kit,
      this.contract.methods.executeHotfix(
        encoded.values,
        encoded.destinations,
        // @ts-ignore bytes type
        encoded.data,
        encoded.dataLengths
      )
    )
  }
}
