# Protocol Reliability Changes

This document outlines the major shifts from the old version of the protocol to the newer, highly reliable stop-and-wait ARQ protocol.

## 1. Strict Stop-and-Wait ARQ
- **Old Behavior:** The sender waited for an ACK but would eventually time out and advance to the next symbol regardless.
- **New Behavior:** The sender strictly waits for an ACK before advancing to the next symbol. It will never move forward until it hears an ACK.

## 2. Timeout & Retransmission Mechanics
- **Sender Connection Timeout:** Introduced a `10 × RTT` timeout mechanism (clamped between 5s and 30s) on the sender side. If the sender doesn't receive an ACK within this window, it assumes the connection is broken and restarts entirely from the initial calibration frame (SYN).
- **Receiver ACK Retransmission:** The receiver now sends an immediate ACK upon detecting a clock change. If it does not observe a change in the sender's clock state after `2 × RTT`, it assumes the ACK was lost and retransmits it.
- **Screen Visibility Check:** The receiver now checks if the sender's screen is actually visible (`rScreenFound`). If the camera view is obstructed (e.g., by a hand), it halts ACK retransmissions to prevent blindly spamming the sender.
- **Receiver Connection Timeout:** Added a symmetric `10 × RTT` timeout to the receiver. If no new symbol is seen during this window, the receiver resets itself to the `IDLE` state (waiting for a fresh calibration frame).

## 3. End of Transmission Validation
- **No NACKs During Transmission:** NACKs are no longer sent mid-transmission. The protocol is entirely self-healing via the ACK-retransmission cycle.
- **Final Bit-Count Verification:** After accumulating the full frame (6 symbols / 48 bits), the receiver attempts to decode. It now specifically checks if the extracted message length matches the header's expected bit count (`result.L`).
- **Restart on Failure:** If the bit count doesn't match or the decoding fails catastrophically, the receiver sends a final NACK. Receiving this NACK instructs the sender to reset and restart from SYN.

## 4. UI Simplifications
- **Removed Hold-Time Slider:** Since the protocol is now strictly ACK-driven and timing is governed by dynamic RTT estimation, the manual "Hold time" slider was removed from the Sender UI in `index.html`. 
