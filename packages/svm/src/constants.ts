import { type Lamports, address as a } from "@solana/kit";

export const lamportsPerByte = 6_960n as Lamports;

export const emptyAccountSize = 128;
export const addressSize      = 32;
export const hashSize         = 32;
export const signatureSize    = 64;
export const maxTxSize        = 1232;
export const minTxSize        =
  //tx that calls one program with no additional accounts or data
    1 //signature count
  + signatureSize
  + 3 //message header
  + 1 //account count
  + 2 * addressSize //at least a feePayer and a program id
  + hashSize //recent block hash
  + 1 //ix count
  + 1 //ix program id index
  + 1 //ix account index count
  + 1; //ix data count
//the instruction-data budget of that minimal transaction: any budget past 127 bytes pushes the
//  data count to the two-byte spelling of compact-u16, which minTxSize counts as one. An
//  optimistic bound for one instruction, one signer and no extra accounts; more of any of
//  those, or a v0 message, leaves less
export const maxUsableTxSize = maxTxSize - minTxSize - 1;

//see https://solana.com/docs/rpc/http/getmultipleaccounts
export const rpcMaxMultipleAccounts = 100;

export const zeroAddress = a("11111111111111111111111111111111");

// Built-in Program IDs - see https://solana.com/docs/core/programs
// and https://github.com/anza-xyz/solana-sdk/blob/master/sdk-ids/src/lib.rs
export const systemProgramId               = zeroAddress;
export const computeBudgetProgramId        = a("ComputeBudget111111111111111111111111111111");
export const bpfLoaderUpgradeableProgramId = a("BPFLoaderUpgradeab1e11111111111111111111111");
export const addressLookupTableProgramId   = a("AddressLookupTab1e1111111111111111111111111");
export const ed25519SigVerifyProgramId     = a("Ed25519SigVerify111111111111111111111111111");
export const keccakSecp256k1ProgramId      = a("KeccakSecp256k11111111111111111111111111111");
export const secp256r1SigVerifyProgramId   = a("Secp256r1SigVerify1111111111111111111111111");
export const zkTokenProofProgramId         = a("ZkTokenProof1111111111111111111111111111111");
export const zkElGamalProofProgramId       = a("ZkE1Gama1Proof11111111111111111111111111111");
export const voteProgramId                 = a("Vote111111111111111111111111111111111111111");
export const stakeProgramId                = a("Stake11111111111111111111111111111111111111");
export const configProgramId               = a("Config1111111111111111111111111111111111111");
export const nativeLoaderProgramId         = a("NativeLoader1111111111111111111111111111111");
export const bpfLoader1ProgramId           = a("BPFLoader1111111111111111111111111111111111");
export const bpfLoader2ProgramId           = a("BPFLoader2111111111111111111111111111111111");
export const loaderV4ProgramId             = a("LoaderV411111111111111111111111111111111111");
export const featureProgramId              = a("Feature111111111111111111111111111111111111");

// Sysvar IDs - see https://docs.solanalabs.com/runtime/sysvars/
export const clockSysvarId                 = a("SysvarC1ock11111111111111111111111111111111");
export const rentSysvarId                  = a("SysvarRent111111111111111111111111111111111");
export const instructionsSysvarId          = a("Sysvar1nstructions1111111111111111111111111");
export const epochScheduleSysvarId         = a("SysvarEpochSchedu1e111111111111111111111111");
export const feesSysvarId                  = a("SysvarFees111111111111111111111111111111111");
export const recentBlockHashesSysvarId     = a("SysvarRecentB1ockHashes11111111111111111111");
export const rewardsSysvarId               = a("SysvarRewards111111111111111111111111111111");
export const slotHashesSysvarId            = a("SysvarS1otHashes111111111111111111111111111");
export const slotHistorySysvarId           = a("SysvarS1otHistory11111111111111111111111111");
export const stakeHistorySysvarId          = a("SysvarStakeHistory1111111111111111111111111");
export const epochRewardsSysvarId          = a("SysvarEpochRewards1111111111111111111111111");
export const lastRestartSlotSysvarId       = a("SysvarLastRestartS1ot1111111111111111111111");

// Default Program IDs
export const tokenProgramId                = a("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const token2022ProgramId            = a("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const memoProgramId                 = a("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");
export const memoV2ProgramId               = a("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const associatedTokenProgramId      = a("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Miscellaneous Addresses
export const incinerator                   = a("1nc1nerator11111111111111111111111111111111");
export const stakeConfig                   = a("StakeConfig11111111111111111111111111111111");
export const nativeMint                    = a("So11111111111111111111111111111111111111112");
export const nativeMint2022                = a("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");

// Groupings
export const builtInProgramIds = [
  systemProgramId,
  computeBudgetProgramId,
  bpfLoaderUpgradeableProgramId,
  addressLookupTableProgramId,
  ed25519SigVerifyProgramId,
  keccakSecp256k1ProgramId,
  secp256r1SigVerifyProgramId,
  zkTokenProofProgramId,
  zkElGamalProofProgramId,
  voteProgramId,
  stakeProgramId,
  configProgramId,
  nativeLoaderProgramId,
  bpfLoader1ProgramId,
  bpfLoader2ProgramId,
  loaderV4ProgramId,
  featureProgramId,
] as const;

export const sysvarIds = [
  clockSysvarId,
  rentSysvarId,
  instructionsSysvarId,
  epochScheduleSysvarId,
  feesSysvarId,
  recentBlockHashesSysvarId,
  rewardsSysvarId,
  slotHashesSysvarId,
  slotHistorySysvarId,
  stakeHistorySysvarId,
  epochRewardsSysvarId,
  lastRestartSlotSysvarId,
] as const;

export const defaultProgramIds = [
  tokenProgramId,
  token2022ProgramId,
  memoProgramId,
  memoV2ProgramId,
  associatedTokenProgramId,
] as const;

export const miscAddresses = [
  incinerator,
  stakeConfig,
  nativeMint,
  nativeMint2022,
] as const;

export const allAddresses = [
  ...builtInProgramIds,
  ...sysvarIds,
  ...defaultProgramIds,
  ...miscAddresses,
] as const;
