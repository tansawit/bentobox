const truffleAssert = require('./helpers/truffle-assertions');
const timeWarp = require("./helpers/timeWarp");
const {e18, e9, getInitData, getDataParameter, sansBorrowFee} = require("./helpers/utils");
const BentoBox = artifacts.require("BentoBox");
const RevertingERC20 = artifacts.require("RevertingERC20");
const SushiSwapFactory = artifacts.require("UniswapV2Factory");
const UniswapV2Pair = artifacts.require("UniswapV2Pair");
const Pair = artifacts.require("LendingPair");
const RebaseToken = artifacts.require("RebaseToken");
const TestOracle = artifacts.require("TestOracle");
const SushiSwapSwapper = artifacts.require("SushiSwapSwapper");
const SimpleSLPOracle0 = artifacts.require("SimpleSLPTWAP0Oracle");
const SimpleSLPOracle1 = artifacts.require("SimpleSLPTWAP1Oracle");

contract('LendingPair with Rebase', (accounts) => {
  let a;
  let b;
  let pair_address;
  let pair;
  let bentoBox;
  let bentoFactory;
  let sushiswappair;
  let swapper;
  const alice = accounts[1];
  const bob = accounts[2];

  describe('rebase as asset', () => {
    before(async () => {
      bentoBox = await BentoBox.deployed();
      pairMaster = await Pair.deployed();

      a = await RevertingERC20.new("Token A", "A", e18(10000000), { from: accounts[0] });
      b = await RebaseToken.new("Rebase Token", "RBT", { from: accounts[0] });

      let factory = await SushiSwapFactory.new(accounts[0], { from: accounts[0] });
      swapper = await SushiSwapSwapper.new(bentoBox.address, factory.address, { from: accounts[0] });
      await pairMaster.setSwapper(swapper.address, true);

      let tx = await factory.createPair(a.address, b.address);
      sushiswappair = await UniswapV2Pair.at(tx.logs[0].args.pair);
      await a.transfer(sushiswappair.address, e18("5000"));
      await b.transfer(sushiswappair.address, e9("5000"));
      await sushiswappair.mint(accounts[0]);

      await a.transfer(alice, e18(1000)); // collateral
      await b.transfer(bob, e9(1000));    // asset

      oracle = await TestOracle.new({ from: accounts[0] });
      await oracle.set(e18(1000000000), accounts[0]);
      let oracleData = await oracle.getDataParameter();

      await bentoBox.setMasterContractApproval(pairMaster.address, true, { from: alice });
      await bentoBox.setMasterContractApproval(pairMaster.address, true, { from: bob });

      let initData = await pairMaster.getInitData(a.address, b.address, oracle.address, oracleData);
      tx = await bentoBox.deploy(pairMaster.address, initData);
      pair_address = tx.logs[0].args[2];
      pair = await Pair.at(pair_address);

      await pair.updateExchangeRate();
    });

    it('should have 9 decimals', async () => {
      assert.equal((await pair.decimals()).toString(), "9");
    });

    it('should not allow any remove without assets', async () => {
      await truffleAssert.reverts(pair.removeCollateral(e18(1), bob), 'BoringMath: Underflow');
      await truffleAssert.reverts(pair.removeAsset(e18(1), bob), 'BoringMath: Underflow');
    });

    it('should not allow borrowing without any assets', async () => {
      await truffleAssert.reverts(pair.borrow(e18(1), bob), 'BoringMath: Underflow');
    });

    it('should take a deposit of assets', async () => {
      await b.approve(bentoBox.address, e9(300), { from: bob });
      await pair.addAsset(e9(300), { from: bob });
    });

    it('should have correct balances after supply of assets', async () => {
      assert.equal((await pair.totalSupply()).toString(), e9(300).toString());
      assert.equal((await pair.balanceOf(bob)).toString(), e9(300).toString());
    });

    it('should not allow borrowing without any collateral', async () => {
      await truffleAssert.reverts(pair.borrow(e9(1), alice, { from: alice }), 'user insolvent');
    });

    it('should take a deposit of collateral', async () => {
      await a.approve(bentoBox.address, e18(100), { from: alice });
      await pair.addCollateral(e18(100), { from: alice });
    });

    it('should have correct balances after supply of collateral', async () => {
      assert.equal((await pair.totalCollateralShare()).toString(), e18(100).toString());
      assert.equal((await pair.userCollateralShare(alice)).toString(), e18(100).toString());
    });

    it('should allow borrowing with collateral up to 75%', async () => {
      await pair.borrow(sansBorrowFee(e9(75)), alice, { from: alice });
    });

    it('should not allow any more borrowing', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000).mul(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await truffleAssert.reverts(pair.borrow(100, alice, { from: alice }), 'user insolvent');
      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should report insolvency due to interest', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000).mul(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await pair.accrue();
      assert.equal(await pair.isSolvent(alice, false), false);
      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000), accounts[0]);
      await pair.updateExchangeRate();
    })

    it('should not report open insolvency due to interest', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000).mul(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await pair.accrue();
      assert.equal(await pair.isSolvent(alice, true), true);
      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should not allow open liquidate yet', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000).mul(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await b.approve(bentoBox.address, e9(25), { from: bob });
      await truffleAssert.reverts(pair.liquidate([alice], [e9(20)], bob, "0x0000000000000000000000000000000000000000", true, { from: bob }), 'all users are solvent');
      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow closed liquidate', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000).mul(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await sushiswappair.sync();

      await pair.liquidate([alice], [e9(10)], bob, swapper.address, false, { from: bob });

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1000000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should report open insolvency after oracle rate is updated', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(2200000000), pair.address);
      await pair.updateExchangeRate();

      assert.equal(await pair.isSolvent(alice, true), false);

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1100000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow open liquidate', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(2200000000), pair.address);
      await pair.updateExchangeRate();

      await b.approve(bentoBox.address, e9(25), { from: bob });
      await pair.liquidate([alice], [e9(10)], bob, "0x0000000000000000000000000000000000000000", true, { from: bob });

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1100000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow repay', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(2200000000), pair.address);
      await pair.updateExchangeRate();

      await b.approve(bentoBox.address, e9(100), { from: alice });
      await pair.repay(e9(50), { from: alice });

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1100000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow full repay with funds', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(2200000000), pair.address);
      await pair.updateExchangeRate();

      let borrowShareLeft = await pair.userBorrowFraction(alice);
      await pair.repay(borrowShareLeft, { from: alice });

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1100000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow partial withdrawal of collateral', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(2200000000), pair.address);
      await pair.updateExchangeRate();

      await pair.removeCollateral(e18(60), alice, { from: alice });

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1100000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should not allow withdrawal of more than collateral', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(2200000000), pair.address);
      await pair.updateExchangeRate();

      await truffleAssert.reverts(pair.removeCollateral(e18(100), alice, { from: alice }), "BoringMath: Underflow");

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1100000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow full withdrawal of collateral', async () => {
      let total = await b.totalSupply();
      await b.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(2200000000), pair.address);
      await pair.updateExchangeRate();

      let shareALeft = await pair.userCollateralShare(alice);
      await pair.removeCollateral(shareALeft, alice, { from: alice });

      await b.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(b.address);
      await oracle.set(e18(1100000000), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should update the interest rate', async () => {
      for (let i = 0; i < 20; i++) {
        await timeWarp.advanceBlock()
      }
      await pair.accrue({ from: alice });
    });
  });

  describe('rebase as collateral', () => {
    before(async () => {
      bentoBox = await BentoBox.deployed();
      pairMaster = await Pair.deployed();

      a = await RebaseToken.new("Rebase Token", "RBT", { from: accounts[0] });
      b = await RevertingERC20.new("Token A", "A", e18(10000000), { from: accounts[0] });

      let factory = await SushiSwapFactory.new(accounts[0], { from: accounts[0] });
      swapper = await SushiSwapSwapper.new(bentoBox.address, factory.address, { from: accounts[0] });
      await pairMaster.setSwapper(swapper.address, true);

      let tx = await factory.createPair(a.address, b.address);
      sushiswappair = await UniswapV2Pair.at(tx.logs[0].args.pair);
      await a.transfer(sushiswappair.address, e9("5000"));
      await b.transfer(sushiswappair.address, e18("5000"));
      await sushiswappair.mint(accounts[0]);

      await a.transfer(alice, e9(1000)); // collateral
      await b.transfer(bob, e18(1000));  // asset

      oracle = await TestOracle.new({ from: accounts[0] });
      await oracle.set(e9(1), accounts[0]);
      let oracleData = await oracle.getDataParameter();

      await bentoBox.setMasterContractApproval(pairMaster.address, true, { from: alice });
      await bentoBox.setMasterContractApproval(pairMaster.address, true, { from: bob });

      let initData = await pairMaster.getInitData(a.address, b.address, oracle.address, oracleData);
      tx = await bentoBox.deploy(pairMaster.address, initData);
      pair_address = tx.logs[0].args[2];
      pair = await Pair.at(pair_address);

      await pair.updateExchangeRate();
    });


    it('should not allow any remove without assets', async () => {
      await truffleAssert.reverts(pair.removeCollateral(e18(1), bob), 'BoringMath: Underflow');
      await truffleAssert.reverts(pair.removeAsset(e18(1), bob), 'BoringMath: Underflow');
    });

    it('should not allow borrowing without any assets', async () => {
      await truffleAssert.reverts(pair.borrow(e18(1), bob), 'BoringMath: Underflow');
    });

    it('should not take deposit without exchange rate', async () => {
      const rate = await pair.exchangeRate();
    });

    it('should take a deposit of assets', async () => {
      await b.approve(bentoBox.address, e18(300), { from: bob });
      await pair.addAsset(e18(300), { from: bob });
    });

    it('should have correct balances after supply of assets', async () => {
      assert.equal((await pair.totalSupply()).toString(), e18(300).toString());
      assert.equal((await pair.balanceOf(bob)).toString(), e18(300).toString());
    });

    it('should not allow borrowing without any collateral', async () => {
      await truffleAssert.reverts(pair.borrow(e18(1), alice, { from: alice }), 'user insolvent');
    });

    it('should take a deposit of collateral', async () => {
      await a.approve(bentoBox.address, e9(100), { from: alice });
      await pair.addCollateral(e9(100), { from: alice });
    });

    it('should have correct balances after supply of collateral', async () => {
      assert.equal((await pair.totalCollateralShare()).toString(), e9(100).toString());
      assert.equal((await pair.userCollateralShare(alice)).toString(), e9(100).toString());
    });

    it('should have correct balances after rebase of collateral', async () => {
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      assert.equal((await pair.totalCollateralShare()).toString(), e9(100).toString());
      assert.equal((await pair.userCollateralShare(alice)).toString(), e9(100).toString());
      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      assert.equal(total.toString(), (await a.totalSupply()).toString(), "supply changes not rolled back correctly");
    });

    it('should allow borrowing with collateral up to 75%', async () => {
      await pair.borrow(sansBorrowFee(e18(75)), alice, { from: alice });
    });

    it('should not allow any more borrowing', async () => {
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1).div(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await truffleAssert.reverts(pair.borrow(100, alice, { from: alice }), 'user insolvent');
      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should report insolvency due to interest', async () => {
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1).div(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await pair.accrue();
      assert.equal(await pair.isSolvent(alice, false), false);
      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    })

    it('should not report open insolvency due to interest', async () => {

      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1).div(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await pair.accrue();
      assert.equal(await pair.isSolvent(alice, true), true);

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should not allow open liquidate yet', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1).div(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await pair.accrue();
      let borrowShareLeft = await pair.userBorrowFraction(alice);
      await b.approve(bentoBox.address, e18(25), { from: bob });
      await truffleAssert.reverts(pair.liquidate([alice], [e18(20)], bob, "0x0000000000000000000000000000000000000000", true, { from: bob }), 'all users are solvent');
      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow closed liquidate', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1).div(new web3.utils.BN(2)), accounts[0]);
      await pair.updateExchangeRate();
      await pair.accrue();

      await sushiswappair.sync();

      await pair.liquidate([alice], [e18(10)], bob, swapper.address, false, { from: bob });

      assert.equal((await pair.userCollateralShare(alice)).toString(), (await bentoBox.shareOf(a.address, pair.address)).toString(), "incorrect shares in BentoBox");

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should report open insolvency after oracle rate is updated', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      assert.equal(await pair.isSolvent(alice, true), false);

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow open liquidate', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      await b.approve(bentoBox.address, e18(25), { from: bob });
      await pair.liquidate([alice], [e18(10)], bob, "0x0000000000000000000000000000000000000000", true, { from: bob });
      assert.equal((await pair.userCollateralShare(alice)).toString(), (await bentoBox.shareOf(a.address, pair.address)).toString(), "incorrect shares in BentoBox");
      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow repay', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      await b.approve(bentoBox.address, e18(100), { from: alice });
      await pair.repay(e18(50), { from: alice });

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow full repay with funds', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      let borrowShareLeft = await pair.userBorrowFraction(alice);
      await pair.repay(borrowShareLeft, { from: alice });

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow partial withdrawal of collateral', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      await pair.removeCollateral(e9(60), alice, { from: alice });
      assert.equal((await pair.userCollateralShare(alice)).toString(), (await bentoBox.shareOf(a.address, pair.address)).toString(), "incorrect shares in BentoBox");

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should not allow withdrawal of more than collateral', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      await truffleAssert.reverts(pair.removeCollateral(e9(100), alice, { from: alice }), "BoringMath: Underflow");
      assert.equal((await pair.userCollateralShare(alice)).toString(), (await bentoBox.shareOf(a.address, pair.address)).toString(), "incorrect shares in BentoBox");

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should allow full withdrawal of collateral', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      await pair.updateExchangeRate();

      let shareALeft = await pair.userCollateralShare(alice);
      assert.equal((await pair.userCollateralShare(alice)).toString(), (await bentoBox.shareOf(a.address, pair.address)).toString(), "incorrect shares in BentoBox");
      await pair.removeCollateral(shareALeft, alice, { from: alice });

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });

    it('should update the interest rate', async () => {
      //total supply is halved through a rebase
      let total = await a.totalSupply();
      await a.rebase(`-${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set('550000000', pair.address);
      await pair.updateExchangeRate();

      for (let i = 0; i < 20; i++) {
        await timeWarp.advanceBlock()
      }
      await pair.accrue({ from: alice });

      await a.rebase(`${total / 2}`);
      // sync and check
      await bentoBox.sync(a.address);
      await oracle.set(e9(1), accounts[0]);
      await pair.updateExchangeRate();
    });
  });
});
