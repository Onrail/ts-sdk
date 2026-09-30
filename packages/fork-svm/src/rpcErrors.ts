import type { TransactionError } from "@solana/kit";
import type { FailedTransactionMetadata,
              TransactionErrorFieldless, InstructionErrorFieldless } from "./liteSvm.js";
import { TransactionErrorInstructionError,
         TransactionErrorDuplicateInstruction,
         TransactionErrorInsufficientFundsForRent, InstructionErrorCustom } from "./liteSvm.js";

//The native bindings return numeric enums without runtime name tables.
//  This checks both exhaustiveness and each index/name pairing against their declarations.
type EnumNames<E> = { [K in keyof E as E[K] & number]: K };

const transactionErrorNames = [
  "AccountInUse",
  "AccountLoadedTwice",
  "AccountNotFound",
  "ProgramAccountNotFound",
  "InsufficientFundsForFee",
  "InvalidAccountForFee",
  "AlreadyProcessed",
  "BlockhashNotFound",
  "CallChainTooDeep",
  "MissingSignatureForFee",
  "InvalidAccountIndex",
  "SignatureFailure",
  "InvalidProgramForExecution",
  "SanitizeFailure",
  "ClusterMaintenance",
  "AccountBorrowOutstanding",
  "WouldExceedMaxBlockCostLimit",
  "UnsupportedVersion",
  "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit",
  "WouldExceedAccountDataBlockLimit",
  "TooManyAccountLocks",
  "AddressLookupTableNotFound",
  "InvalidAddressLookupTableOwner",
  "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex",
  "InvalidRentPayingAccount",
  "WouldExceedMaxVoteCostLimit",
  "WouldExceedAccountDataTotalLimit",
  "MaxLoadedAccountsDataSizeExceeded",
  "ResanitizationNeeded",
  "InvalidLoadedAccountsDataSizeLimit",
  "UnbalancedTransaction",
  "ProgramCacheHitMaxLimit",
  "CommitCancelled",
] as const satisfies EnumNames<typeof TransactionErrorFieldless>;

const instructionErrorNames = [
  "GenericError",
  "InvalidArgument",
  "InvalidInstructionData",
  "InvalidAccountData",
  "AccountDataTooSmall",
  "InsufficientFunds",
  "IncorrectProgramId",
  "MissingRequiredSignature",
  "AccountAlreadyInitialized",
  "UninitializedAccount",
  "UnbalancedInstruction",
  "ModifiedProgramId",
  "ExternalAccountLamportSpend",
  "ExternalAccountDataModified",
  "ReadonlyLamportChange",
  "ReadonlyDataModified",
  "DuplicateAccountIndex",
  "ExecutableModified",
  "RentEpochModified",
  "NotEnoughAccountKeys",
  "AccountDataSizeChanged",
  "AccountNotExecutable",
  "AccountBorrowFailed",
  "AccountBorrowOutstanding",
  "DuplicateAccountOutOfSync",
  "InvalidError",
  "ExecutableDataModified",
  "ExecutableLamportChange",
  "ExecutableAccountNotRentExempt",
  "UnsupportedProgramId",
  "CallDepth",
  "MissingAccount",
  "ReentrancyNotAllowed",
  "MaxSeedLengthExceeded",
  "InvalidSeeds",
  "InvalidRealloc",
  "ComputationalBudgetExceeded",
  "PrivilegeEscalation",
  "ProgramEnvironmentSetupFailure",
  "ProgramFailedToComplete",
  "ProgramFailedToCompile",
  "Immutable",
  "IncorrectAuthority",
  "AccountNotRentExempt",
  "InvalidAccountOwner",
  "ArithmeticOverflow",
  "UnsupportedSysvar",
  "IllegalOwner",
  "MaxAccountsDataAllocationsExceeded",
  "MaxAccountsExceeded",
  "MaxInstructionTraceLengthExceeded",
  "BuiltinProgramsMustConsumeComputeUnits",
  "BorshIoError",
] as const satisfies EnumNames<typeof InstructionErrorFieldless>;

//Kit's union omits two fieldless variants present in the pinned native bindings.
type RpcTransactionError = TransactionError | keyof typeof TransactionErrorFieldless;

export function transactionErrorToRpc(
  error: ReturnType<FailedTransactionMetadata["err"]>,
): RpcTransactionError {
  if (typeof error === "number")
    return transactionErrorNames[error];

  if (error instanceof TransactionErrorInstructionError) {
    const instructionError = error.err();
    return { InstructionError: [
      error.index,
      typeof instructionError === "number"
      ? instructionErrorNames[instructionError]
      : instructionError instanceof InstructionErrorCustom
      ? { Custom: instructionError.code }
      //Solana's BorshIoError is fieldless; the bindings also declare a legacy message wrapper.
      : "BorshIoError",
    ] };
  }

  if (error instanceof TransactionErrorDuplicateInstruction)
    return { DuplicateInstruction: error.index };

  if (error instanceof TransactionErrorInsufficientFundsForRent)
    return { InsufficientFundsForRent: { account_index: error.accountIndex } };

  return { ProgramExecutionTemporarilyRestricted: { account_index: error.accountIndex } };
}
