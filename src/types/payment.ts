
export enum PaymentFlow {
    ELICITATION = "ELICITATION",
    TWO_STEP = "TWO_STEP",
    PROGRESS = "PROGRESS",
    OOB = "OOB"
    // TODO: OOB
}

export interface CreatePaymentResult {
  paymentId: string;
  paymentUrl: string; 
}