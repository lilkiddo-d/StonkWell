const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const Kind = { Well: 0n, CreditLine: 1n, Program: 2n };

describe("WellRegistry", function () {
  async function registryFixture() {
    const [owner, other, newOwner, wellA, wellB, desk, program] = await ethers.getSigners();
    const registry = await ethers.deployContract("WellRegistry", [owner.address]);
    return { registry, owner, other, newOwner, wellA, wellB, desk, program };
  }

  function asPlain(e) {
    return { target: e.target, kind: e.kind, ticker: e.ticker, listed: e.listed };
  }

  it("starts empty with the given owner", async function () {
    const { registry, owner, wellA } = await loadFixture(registryFixture);
    expect(await registry.owner()).to.equal(owner.address);
    expect(await registry.entries()).to.deep.equal([]);
    expect(await registry.indexPlusOne(wellA)).to.equal(0n);
  });

  it("rejects a zero owner", async function () {
    const F = await ethers.getContractFactory("WellRegistry");
    await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "OwnableInvalidOwner");
  });

  it("lists Wells, Credit Lines and Programs in order", async function () {
    const { registry, owner, wellA, desk, program } = await loadFixture(registryFixture);
    await expect(registry.connect(owner).list(wellA.address, Kind.Well, "AMD"))
      .to.emit(registry, "Listed")
      .withArgs(wellA.address, Kind.Well, "AMD");
    await registry.connect(owner).list(desk.address, Kind.CreditLine, "clAMD");
    await registry.connect(owner).list(program.address, Kind.Program, "BASKET");

    const e = (await registry.entries()).map(asPlain);
    expect(e).to.deep.equal([
      { target: wellA.address, kind: Kind.Well, ticker: "AMD", listed: true },
      { target: desk.address, kind: Kind.CreditLine, ticker: "clAMD", listed: true },
      { target: program.address, kind: Kind.Program, ticker: "BASKET", listed: true },
    ]);
    expect(await registry.indexPlusOne(wellA)).to.equal(1n);
    expect(await registry.indexPlusOne(desk)).to.equal(2n);
    expect(await registry.indexPlusOne(program)).to.equal(3n);
  });

  it("rejects listing the same target twice", async function () {
    const { registry, owner, wellA } = await loadFixture(registryFixture);
    await registry.connect(owner).list(wellA.address, Kind.Well, "AMD");
    await expect(registry.connect(owner).list(wellA.address, Kind.CreditLine, "OTHER")).to.be.revertedWithCustomError(
      registry,
      "AlreadyListed"
    );
  });

  it("delists by flag, keeping the entry and its index", async function () {
    const { registry, owner, wellA, wellB } = await loadFixture(registryFixture);
    await registry.connect(owner).list(wellA.address, Kind.Well, "AMD");
    await registry.connect(owner).list(wellB.address, Kind.Well, "TSLA");
    await expect(registry.connect(owner).delist(wellA.address)).to.emit(registry, "Delisted").withArgs(wellA.address);
    const e = (await registry.entries()).map(asPlain);
    expect(e[0]).to.deep.equal({ target: wellA.address, kind: Kind.Well, ticker: "AMD", listed: false });
    expect(e[1].listed).to.equal(true);
    expect(await registry.indexPlusOne(wellA)).to.equal(1n);
    // a delisted target keeps its slot, so it cannot be listed again
    await expect(registry.connect(owner).list(wellA.address, Kind.Well, "AMD")).to.be.revertedWithCustomError(
      registry,
      "AlreadyListed"
    );
  });

  it("rejects delisting an unknown target", async function () {
    const { registry, owner, wellA } = await loadFixture(registryFixture);
    await expect(registry.connect(owner).delist(wellA.address)).to.be.revertedWithCustomError(registry, "Unknown");
  });

  it("restricts list and delist to the owner", async function () {
    const { registry, owner, other, wellA } = await loadFixture(registryFixture);
    await expect(registry.connect(other).list(wellA.address, Kind.Well, "AMD"))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
    await registry.connect(owner).list(wellA.address, Kind.Well, "AMD");
    await expect(registry.connect(other).delist(wellA.address))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
  });

  it("transfers ownership in two steps", async function () {
    const { registry, owner, other, newOwner, wellA } = await loadFixture(registryFixture);
    await registry.connect(owner).transferOwnership(newOwner.address);
    expect(await registry.pendingOwner()).to.equal(newOwner.address);
    await expect(registry.connect(other).acceptOwnership()).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
    // still the old owner until accepted
    await registry.connect(owner).list(wellA.address, Kind.Well, "AMD");
    await registry.connect(newOwner).acceptOwnership();
    expect(await registry.owner()).to.equal(newOwner.address);
    await expect(registry.connect(owner).delist(wellA.address)).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
    await registry.connect(newOwner).delist(wellA.address);
  });
});
