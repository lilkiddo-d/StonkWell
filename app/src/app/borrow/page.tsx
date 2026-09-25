import { BorrowDeskList } from "@/components/BorrowDeskList";

export default function BorrowPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Borrow Desk</h1>
          <p className="muted">
            Each Credit Line is an isolated market: USDG lenders on one side, holders of one Well's shares on the other.
            Borrowing and liquidation need a fresh Chainlink price. Repaying is always open.
          </p>
        </div>
      </div>
      <BorrowDeskList />
    </div>
  );
}
