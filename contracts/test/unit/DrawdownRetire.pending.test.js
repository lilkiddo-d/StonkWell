// Deploying before $WELL exists: DrawdownRetire starts without a token, and `wellTokenSetter` sets it exactly once.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, baseFixture } = require("./fixtures");

describe("DrawdownRetire deployed before $WELL", function () {
  async function pending() {
    const ctx = await baseFixture();
    const [, , , , , , setter] = await ethers.getSigners();
    const drawdown = await ethers.deployContract("DrawdownRetire", [
      ethers.ZeroAddress,
      ctx.swap,
      ctx.admin.address,
      ctx.guardian.address,
      ctx.keeper.address,
      0,
      setter.address,
    ]);
    await drawdown.connect(ctx.admin).setInputLimit(ctx.usdg, USDG(1_000));
    await ctx.usdg.mint(drawdown, USDG(500)); // fees routed in before $WELL exists
    return { ...ctx, drawdown, setter };
  }

  describe("constructor", function () {
    it("needs either a token or a setter", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("DrawdownRetire");
      const base = [ctx.swap.target, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 0];
      await expect(F.deploy(ethers.ZeroAddress, ...base, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "InvalidConfig");
    });

    it("starts empty with the setter recorded", async function () {
      const { drawdown, setter } = await loadFixture(pending);
      expect(await drawdown.wellToken()).to.equal(ethers.ZeroAddress);
      expect(await drawdown.wellTokenSetter()).to.equal(setter.address);
    });

    it("ignores the setter when the token is fixed at deployment", async function () {
      const ctx = await loadFixture(baseFixture);
      const d = await ethers.deployContract("DrawdownRetire", [
        ctx.wellToken, ctx.swap, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 0, ctx.alice.address,
      ]);
      expect(await d.wellToken()).to.equal(ctx.wellToken.target);
      expect(await d.wellTokenSetter()).to.equal(ethers.ZeroAddress);
      await expect(d.connect(ctx.alice).setWellToken(ctx.usdg)).to.be.revertedWithCustomError(d, "Unauthorized");
    });
  });

  describe("before the token is set", function () {
    it("holds fees and refuses to draw down", async function () {
      const { drawdown, keeper, usdg } = await loadFixture(pending);
      await expect(drawdown.connect(keeper).drawdown(usdg, USDG(100), 1n, "0x")).to.be.revertedWithCustomError(drawdown, "WellTokenUnset");
      expect(await usdg.balanceOf(drawdown)).to.equal(USDG(500));
    });

    it("treats retireHeld as a no-op", async function () {
      const { drawdown } = await loadFixture(pending);
      await expect(drawdown.retireHeld()).to.not.be.reverted;
      expect(await drawdown.totalRetired()).to.equal(0n);
    });
  });

  describe("setWellToken", function () {
    it("only the setter can call it", async function () {
      const { drawdown, admin, alice, wellToken } = await loadFixture(pending);
      await expect(drawdown.connect(alice).setWellToken(wellToken)).to.be.revertedWithCustomError(drawdown, "Unauthorized");
      // Not even the admin: the setter is the only key with this power.
      await expect(drawdown.connect(admin).setWellToken(wellToken)).to.be.revertedWithCustomError(drawdown, "Unauthorized");
    });

    it("rejects the zero address", async function () {
      const { drawdown, setter } = await loadFixture(pending);
      await expect(drawdown.connect(setter).setWellToken(ethers.ZeroAddress)).to.be.revertedWithCustomError(drawdown, "InvalidConfig");
    });

    it("sets the token once and can never change it", async function () {
      const { drawdown, setter, wellToken, usdg } = await loadFixture(pending);
      await expect(drawdown.connect(setter).setWellToken(wellToken)).to.emit(drawdown, "WellTokenSet").withArgs(wellToken.target);
      expect(await drawdown.wellToken()).to.equal(wellToken.target);
      await expect(drawdown.connect(setter).setWellToken(usdg)).to.be.revertedWithCustomError(drawdown, "WellTokenAlreadySet");
      await expect(drawdown.connect(setter).setWellToken(wellToken)).to.be.revertedWithCustomError(drawdown, "WellTokenAlreadySet");
    });

    it("then spends the fees that waited and burns the $WELL", async function () {
      const { drawdown, setter, keeper, wellToken, usdg } = await loadFixture(pending);
      await drawdown.connect(setter).setWellToken(wellToken);
      const supply = await wellToken.totalSupply();
      await expect(drawdown.connect(keeper).drawdown(usdg, USDG(500), 1n, "0x")).to.emit(drawdown, "Retired");
      const retired = await drawdown.totalRetired();
      expect(retired).to.be.gt(0n);
      expect(await wellToken.totalSupply()).to.equal(supply - retired);
      expect(await usdg.balanceOf(drawdown)).to.equal(0n);
    });
  });
});
